package engine

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"math"
	"net"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/net/icmp"
	"golang.org/x/net/ipv4"
	"golang.org/x/net/ipv6"
	"smoker/internal/protocol"
)

const (
	mtrMaxHops    = 30
	mtrRounds     = 5
	mtrRDNSBudget = 450 * time.Millisecond
)

var (
	// Limit simultaneous active MTR traces per probe to prevent raw ICMP storms during wide outages.
	mtrSem       = make(chan struct{}, 2)
	mtrIDCounter atomic.Uint32
	mtrIDSeed    = func() uint32 {
		var b [2]byte
		if _, err := rand.Read(b[:]); err == nil {
			return uint32(binary.BigEndian.Uint16(b[:]))
		}
		return 0x5A00
	}()
)

type mtrReply struct {
	ip     string
	recvAt time.Time
	isDest bool
}

type mtrHopStat struct {
	ips  map[string]int
	rtts []float64
	sent int
}

// ExtractMTRHost normalizes URL, host:port, [ipv6]:port, or bare hostname/IP inputs for traceroute resolution.
func ExtractMTRHost(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", fmt.Errorf("empty target host")
	}

	if strings.Contains(s, "://") {
		u, err := url.Parse(s)
		if err != nil {
			return "", fmt.Errorf("invalid target URL %q: %w", raw, err)
		}
		h := strings.TrimSpace(u.Hostname())
		if h == "" {
			return "", fmt.Errorf("target URL %q has no hostname", raw)
		}
		return h, nil
	}

	unbracketed := strings.TrimSuffix(strings.TrimPrefix(s, "["), "]")
	if net.ParseIP(unbracketed) != nil {
		return unbracketed, nil
	}

	if slash := strings.IndexByte(s, '/'); slash >= 0 {
		s = s[:slash]
	}

	if h, _, err := net.SplitHostPort(s); err == nil && strings.TrimSpace(h) != "" {
		return strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(h), "["), "]"), nil
	}

	s = strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(s), "["), "]")
	if s == "" {
		return "", fmt.Errorf("empty hostname in %q", raw)
	}
	return s, nil
}

func nextMTRICMPID() int {
	seq := mtrIDCounter.Add(1)
	return int(((seq + mtrIDSeed) & 0x7fff) | 0x8000)
}

func openMTRSocket(isV6 bool, bindIP net.IP) (*icmp.PacketConn, int, bool, error) {
	if isV6 {
		addr := "::"
		if bindIP != nil && bindIP.To4() == nil && bindIP.To16() != nil {
			addr = bindIP.To16().String()
		}
		if c, err := icmp.ListenPacket("ip6:ipv6-icmp", addr); err == nil {
			return c, 58, true, nil
		}
		if c, err := icmp.ListenPacket("udp6", addr); err == nil {
			return c, 58, false, nil
		}
		if addr != "::" {
			if c, err := icmp.ListenPacket("ip6:ipv6-icmp", "::"); err == nil {
				return c, 58, true, nil
			}
			c, err := icmp.ListenPacket("udp6", "::")
			return c, 58, false, err
		}
		c, err := icmp.ListenPacket("udp6", addr)
		return c, 58, false, err
	}
	addr := "0.0.0.0"
	if bindIP != nil && bindIP.To4() != nil {
		addr = bindIP.To4().String()
	}
	if c, err := icmp.ListenPacket("ip4:icmp", addr); err == nil {
		return c, 1, true, nil
	}
	if c, err := icmp.ListenPacket("udp4", addr); err == nil {
		return c, 1, false, nil
	}
	if addr != "0.0.0.0" {
		if c, err := icmp.ListenPacket("ip4:icmp", "0.0.0.0"); err == nil {
			return c, 1, true, nil
		}
		c, err := icmp.ListenPacket("udp4", "0.0.0.0")
		return c, 1, false, err
	}
	c, err := icmp.ListenPacket("udp4", addr)
	return c, 1, false, err
}

func extractPeerIP(peer net.Addr) string {
	switch a := peer.(type) {
	case *net.IPAddr:
		return a.IP.String()
	case *net.UDPAddr:
		return a.IP.String()
	default:
		return ""
	}
}

// RunMTR executes a bounded concurrent TTL-incrementing ICMP traceroute (IPv4/IPv6) with rDNS lookup.
func RunMTR(ctx context.Context, rawHost string) ([]protocol.MTRHop, error) {
	return RunMTRWithOptions(ctx, rawHost, false, ProberOptions{})
}

// RunMTRWithFamily executes an ICMP traceroute, forcing AAAA/ICMPv6 resolution when forceIPv6 is true.
func RunMTRWithFamily(ctx context.Context, rawHost string, forceIPv6 bool) ([]protocol.MTRHop, error) {
	return RunMTRWithOptions(ctx, rawHost, forceIPv6, ProberOptions{})
}

// RunMTRWithOptions executes an ICMP traceroute bound to optional IPv4/IPv6 source addresses.
func RunMTRWithOptions(ctx context.Context, rawHost string, forceIPv6 bool, opts ProberOptions) ([]protocol.MTRHop, error) {
	host, err := ExtractMTRHost(rawHost)
	if err != nil {
		return nil, err
	}

	select {
	case mtrSem <- struct{}{}:
		defer func() { <-mtrSem }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	family := "ip"
	if forceIPv6 {
		family = "ip6"
	} else if opts.SourceIP4 != nil && opts.SourceIP6 == nil {
		family = "ip4"
	}
	ip, err := resolveHostIPWithFamily(ctx, host, family)
	if err != nil {
		return nil, err
	}
	ip4 := ip.To4()
	isV6 := ip4 == nil
	dstIP := ip4
	bindIP := opts.SourceIP4
	if isV6 {
		dstIP = ip.To16()
		if dstIP == nil {
			return nil, fmt.Errorf("unsupported destination IP for %s", host)
		}
		bindIP = opts.SourceIP6
	}

	conn, proto, isRaw, err := openMTRSocket(isV6, bindIP)
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	var p4 *ipv4.PacketConn
	var p6 *ipv6.PacketConn
	if isV6 {
		p6 = conn.IPv6PacketConn()
	} else {
		p4 = conn.IPv4PacketConn()
	}

	var dstAddr net.Addr
	if isRaw {
		dstAddr = &net.IPAddr{IP: dstIP}
	} else {
		dstAddr = &net.UDPAddr{IP: dstIP}
	}

	icmpID := nextMTRICMPID()

	stats := make([]mtrHopStat, mtrMaxHops+1)
	for i := 1; i <= mtrMaxHops; i++ {
		stats[i].ips = make(map[string]int)
	}

	var mu sync.Mutex
	sentTimes := make(map[int]time.Time)
	ttlBySeq := make(map[int]int)
	replies := make(map[int]mtrReply)

	readCtx, cancelRead := context.WithCancel(ctx)
	defer cancelRead()

	go func() {
		buf := make([]byte, 1500)
		for {
			_ = conn.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
			n, peer, err := conn.ReadFrom(buf)
			if readCtx.Err() != nil {
				return
			}
			if err != nil {
				continue
			}
			recvAt := time.Now()
			msg, err := icmp.ParseMessage(proto, buf[:n])
			if err != nil {
				continue
			}
			peerIP := extractPeerIP(peer)

			switch msg.Type {
			case ipv4.ICMPTypeEchoReply, ipv6.ICMPTypeEchoReply:
				echo, ok := msg.Body.(*icmp.Echo)
				if !ok || (isRaw && echo.ID != icmpID) {
					continue
				}
				mu.Lock()
				if _, known := sentTimes[echo.Seq]; known {
					replies[echo.Seq] = mtrReply{ip: peerIP, recvAt: recvAt, isDest: true}
				}
				mu.Unlock()
			case ipv4.ICMPTypeTimeExceeded, ipv6.ICMPTypeTimeExceeded:
				te, ok := msg.Body.(*icmp.TimeExceeded)
				if !ok {
					continue
				}
				id, seq, ok := ExtractOriginalICMPSeq(te.Data)
				if !ok || (isRaw && id != icmpID) {
					continue
				}
				mu.Lock()
				if _, known := sentTimes[seq]; known {
					replies[seq] = mtrReply{ip: peerIP, recvAt: recvAt, isDest: false}
				}
				mu.Unlock()
			}
		}
	}()

	reqType := icmp.Type(ipv4.ICMPTypeEcho)
	if isV6 {
		reqType = ipv6.ICMPTypeEchoRequest
	}

	seqCounter := 1
	for round := 0; round < mtrRounds; round++ {
		if ctx.Err() != nil {
			break
		}
		for ttl := 1; ttl <= mtrMaxHops; ttl++ {
			seq := seqCounter
			seqCounter++

			mu.Lock()
			sentTimes[seq] = time.Now()
			ttlBySeq[seq] = ttl
			stats[ttl].sent++
			mu.Unlock()

			if isV6 {
				if p6 != nil {
					_ = p6.SetHopLimit(ttl)
				}
			} else if p4 != nil {
				_ = p4.SetTTL(ttl)
			}

			msg := icmp.Message{
				Type: reqType,
				Code: 0,
				Body: &icmp.Echo{
					ID:   icmpID,
					Seq:  seq,
					Data: []byte("SMOKER-MTR"),
				},
			}
			wb, err := msg.Marshal(nil)
			if err == nil {
				_, _ = conn.WriteTo(wb, dstAddr)
			}
		}
		select {
		case <-ctx.Done():
		case <-time.After(450 * time.Millisecond):
		}
	}

	// Wait slightly for stragglers before stopping reader
	select {
	case <-ctx.Done():
	case <-time.After(250 * time.Millisecond):
	}
	cancelRead()

	mu.Lock()
	destTTL := 0
	lastRespondingTTL := 0
	for seq, rep := range replies {
		ttl := ttlBySeq[seq]
		if ttl < 1 || ttl > mtrMaxHops {
			continue
		}
		if rep.ip != "" && ttl > lastRespondingTTL {
			lastRespondingTTL = ttl
		}
		if rep.isDest && (destTTL == 0 || ttl < destTTL) {
			destTTL = ttl
		}
		sentAt, ok := sentTimes[seq]
		if !ok {
			continue
		}
		rttUs := float64(rep.recvAt.Sub(sentAt).Microseconds())
		if rttUs < 0 {
			rttUs = 0
		}
		stats[ttl].rtts = append(stats[ttl].rtts, rttUs)
		if rep.ip != "" {
			stats[ttl].ips[rep.ip]++
		}
	}
	mu.Unlock()

	hops := buildTrimmedMTRHops(stats, mtrMaxHops, destTTL, lastRespondingTTL)
	resolveHopHosts(ctx, hops)
	return hops, nil
}

func trimCutoffTTL(maxHops, destTTL, lastRespondingTTL int) int {
	if destTTL > 0 && destTTL <= maxHops {
		return destTTL
	}
	if lastRespondingTTL > 0 {
		if tail := lastRespondingTTL + 2; tail < maxHops {
			return tail
		}
		return maxHops
	}
	if maxHops > 3 {
		return 3
	}
	return maxHops
}

func buildTrimmedMTRHops(stats []mtrHopStat, maxHops, destTTL, lastRespondingTTL int) []protocol.MTRHop {
	cutTTL := trimCutoffTTL(maxHops, destTTL, lastRespondingTTL)
	hops := make([]protocol.MTRHop, 0, cutTTL)
	for ttl := 1; ttl <= cutTTL && ttl < len(stats); ttl++ {
		st := stats[ttl]
		topIP := "*"
		topCnt := 0
		for addr, cnt := range st.ips {
			if cnt > topCnt {
				topIP = addr
				topCnt = cnt
			}
		}

		recv := len(st.rtts)
		sent := st.sent
		lossPct := 100.0
		if sent > 0 {
			lossPct = math.Round(((float64(sent-recv)*100.0)/float64(sent))*10) / 10
		}

		var best, avg, worst, stdev int32
		if recv > 0 {
			minV, maxV, sum := st.rtts[0], st.rtts[0], 0.0
			for _, v := range st.rtts {
				if v < minV {
					minV = v
				}
				if v > maxV {
					maxV = v
				}
				sum += v
			}
			mean := sum / float64(recv)
			var sqDiff float64
			for _, v := range st.rtts {
				d := v - mean
				sqDiff += d * d
			}
			sd := math.Sqrt(sqDiff / float64(recv))
			best = int32(minV)
			avg = int32(mean)
			worst = int32(maxV)
			stdev = int32(sd)
		}

		hops = append(hops, protocol.MTRHop{
			Hop:     ttl,
			IP:      topIP,
			Sent:    sent,
			Recv:    recv,
			LossPct: lossPct,
			BestUs:  best,
			AvgUs:   avg,
			WorstUs: worst,
			StDevUs: stdev,
		})
	}
	return hops
}

func resolveHopHosts(parentCtx context.Context, hops []protocol.MTRHop) {
	if len(hops) == 0 {
		return
	}
	uniqueIPs := make(map[string]struct{})
	for _, h := range hops {
		if h.IP != "" && h.IP != "*" {
			uniqueIPs[h.IP] = struct{}{}
		}
	}
	if len(uniqueIPs) == 0 {
		return
	}

	ctx, cancel := context.WithTimeout(parentCtx, mtrRDNSBudget)
	defer cancel()

	var mu sync.Mutex
	resolved := make(map[string]string, len(uniqueIPs))
	var wg sync.WaitGroup
	for ip := range uniqueIPs {
		ipAddr := ip
		wg.Add(1)
		go func() {
			defer wg.Done()
			names, err := net.DefaultResolver.LookupAddr(ctx, ipAddr)
			if err != nil || len(names) == 0 {
				names, err = fallbackPublicDNSResolver.LookupAddr(ctx, ipAddr)
				if err != nil || len(names) == 0 {
					return
				}
			}
			host := strings.TrimSuffix(strings.TrimSpace(names[0]), ".")
			if host == "" {
				return
			}
			mu.Lock()
			resolved[ipAddr] = host
			mu.Unlock()
		}()
	}
	wg.Wait()

	for i := range hops {
		if name, ok := resolved[hops[i].IP]; ok {
			hops[i].Host = name
		}
	}
}

// ExtractOriginalICMPSeq parses the embedded IPv4/IPv6 header + 8-byte ICMP echo payload from TimeExceeded data.
func ExtractOriginalICMPSeq(data []byte) (id int, seq int, ok bool) {
	if len(data) < 28 {
		return 0, 0, false
	}
	version := data[0] >> 4
	switch version {
	case 4:
		ihl := int(data[0]&0x0f) * 4
		if ihl < 20 || len(data) < ihl+8 {
			return 0, 0, false
		}
		id = int(binary.BigEndian.Uint16(data[ihl+4 : ihl+6]))
		seq = int(binary.BigEndian.Uint16(data[ihl+6 : ihl+8]))
		return id, seq, true
	case 6:
		const v6HdrLen = 40
		if len(data) < v6HdrLen+8 {
			return 0, 0, false
		}
		id = int(binary.BigEndian.Uint16(data[v6HdrLen+4 : v6HdrLen+6]))
		seq = int(binary.BigEndian.Uint16(data[v6HdrLen+6 : v6HdrLen+8]))
		return id, seq, true
	default:
		return 0, 0, false
	}
}
