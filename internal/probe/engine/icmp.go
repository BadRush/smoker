package engine

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/net/icmp"
	"golang.org/x/net/ipv4"
	"golang.org/x/net/ipv6"
)

func randomICMPID() int {
	var b [2]byte
	if _, err := rand.Read(b[:]); err == nil {
		id := int(binary.BigEndian.Uint16(b[:]))
		if id == 0 {
			return 1
		}
		return id
	}
	fallback := os.Getpid() & 0xffff
	if fallback == 0 {
		return 1
	}
	return fallback
}

type icmpSocket struct {
	conn   *icmp.PacketConn
	isRaw  bool
	isV6   bool
	icmpID int
	seq    atomic.Uint32
	waiters sync.Map // uint16 -> chan time.Time
}

func openICMPSocket(isV6 bool, bindIP net.IP) (*icmpSocket, error) {
	network := "ip4:icmp"
	fallback := "udp4"
	addr := "0.0.0.0"
	if isV6 {
		network = "ip6:ipv6-icmp"
		fallback = "udp6"
		addr = "::"
	}
	defaultAddr := addr
	if bindIP != nil {
		if !isV6 && bindIP.To4() != nil {
			addr = bindIP.To4().String()
		} else if isV6 && bindIP.To4() == nil && bindIP.To16() != nil {
			addr = bindIP.To16().String()
		}
	}

	isRaw := true
	conn, err := icmp.ListenPacket(network, addr)
	if err != nil {
		isRaw = false
		conn, err = icmp.ListenPacket(fallback, addr)
		if err != nil && addr != defaultAddr {
			// If bound source IP is temporarily unavailable on host interface, fallback to wildcard address
			isRaw = true
			conn, err = icmp.ListenPacket(network, defaultAddr)
			if err != nil {
				isRaw = false
				conn, err = icmp.ListenPacket(fallback, defaultAddr)
			}
		}
		if err != nil {
			return nil, fmt.Errorf("listen %s/%s on %s: %w", network, fallback, addr, err)
		}
	}

	s := &icmpSocket{
		conn:   conn,
		isRaw:  isRaw,
		isV6:   isV6,
		icmpID: randomICMPID(),
	}
	go s.readLoop()
	return s, nil
}

func (s *icmpSocket) Close() error {
	return s.conn.Close()
}

func (s *icmpSocket) readLoop() {
	buf := make([]byte, 1500)
	proto := 1 // ICMPv4
	wantType := icmp.Type(ipv4.ICMPTypeEchoReply)
	if s.isV6 {
		proto = 58 // ICMPv6
		wantType = ipv6.ICMPTypeEchoReply
	}

	for {
		n, _, err := s.conn.ReadFrom(buf)
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			continue
		}
		recvAt := time.Now()
		msg, err := icmp.ParseMessage(proto, buf[:n])
		if err != nil || msg.Type != wantType {
			continue
		}
		echo, ok := msg.Body.(*icmp.Echo)
		if !ok {
			continue
		}
		if s.isRaw && echo.ID != s.icmpID {
			continue
		}
		if chVal, ok := s.waiters.Load(uint16(echo.Seq)); ok {
			ch := chVal.(chan time.Time)
			select {
			case ch <- recvAt:
			default:
			}
		}
	}
}

func (s *icmpSocket) ping(ctx context.Context, ip net.IP, timeout time.Duration) (time.Duration, error) {
	seq := uint16(s.seq.Add(1))
	ch := make(chan time.Time, 1)
	s.waiters.Store(seq, ch)
	defer s.waiters.Delete(seq)

	typ := icmp.Type(ipv4.ICMPTypeEcho)
	proto := 1
	if s.isV6 {
		typ = ipv6.ICMPTypeEchoRequest
		proto = 58
	}
	_ = proto

	msg := icmp.Message{
		Type: typ,
		Code: 0,
		Body: &icmp.Echo{
			ID:   s.icmpID,
			Seq:  int(seq),
			Data: []byte("SMOKER-ECHO"),
		},
	}
	wb, err := msg.Marshal(nil)
	if err != nil {
		return 0, err
	}

	var dst net.Addr
	if s.isRaw {
		dst = &net.IPAddr{IP: ip}
	} else {
		dst = &net.UDPAddr{IP: ip}
	}

	sentAt := time.Now()
	if _, err := s.conn.WriteTo(wb, dst); err != nil {
		return 0, err
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case <-ctx.Done():
		return 0, ctx.Err()
	case <-timer.C:
		return 0, context.DeadlineExceeded
	case recvAt := <-ch:
		rtt := recvAt.Sub(sentAt)
		if rtt < 0 {
			rtt = 0
		}
		return rtt, nil
	}
}

type ICMPProber struct {
	mu   sync.Mutex
	opts ProberOptions
	v4   *icmpSocket
	v6   *icmpSocket
}

func NewICMPProber() (*ICMPProber, error) {
	return NewICMPProberWithOptions(ProberOptions{})
}

func NewICMPProberWithOptions(opts ProberOptions) (*ICMPProber, error) {
	v4, err := openICMPSocket(false, opts.SourceIP4)
	if err != nil {
		return nil, err
	}
	v6, _ := openICMPSocket(true, opts.SourceIP6) // Best-effort IPv6 at init; lazily retried on PingIPv6
	return &ICMPProber{opts: opts, v4: v4, v6: v6}, nil
}

func (p *ICMPProber) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.v4 != nil {
		_ = p.v4.Close()
	}
	if p.v6 != nil {
		_ = p.v6.Close()
	}
}

func (p *ICMPProber) ensureV6() (*icmpSocket, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.v6 != nil {
		return p.v6, nil
	}
	s, err := openICMPSocket(true, p.opts.SourceIP6)
	if err != nil {
		return nil, fmt.Errorf("ipv6 icmp unavailable: %w", err)
	}
	p.v6 = s
	return s, nil
}

func (p *ICMPProber) Ping(ctx context.Context, host string, timeout time.Duration) (time.Duration, error) {
	ip, err := resolveHostIPWithFamily(ctx, host, "ip")
	if err != nil {
		return 0, err
	}
	if ip4 := ip.To4(); ip4 != nil {
		return p.v4.ping(ctx, ip4, timeout)
	}
	v6, err := p.ensureV6()
	if err != nil {
		return 0, err
	}
	return v6.ping(ctx, ip.To16(), timeout)
}

func (p *ICMPProber) PingIPv6(ctx context.Context, host string, timeout time.Duration) (time.Duration, error) {
	ip, err := resolveHostIPWithFamily(ctx, host, "ip6")
	if err != nil {
		return 0, err
	}
	ip6 := ip.To16()
	if ip6 == nil || ip.To4() != nil {
		return 0, fmt.Errorf("expected ipv6 address for %s, got %s", host, ip.String())
	}
	v6, err := p.ensureV6()
	if err != nil {
		return 0, err
	}
	return v6.ping(ctx, ip6, timeout)
}

var fallbackPublicDNSResolver = &net.Resolver{
	PreferGo: true,
	Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		d.Timeout = 2 * time.Second
		if c, err := d.DialContext(ctx, "udp", "1.1.1.1:53"); err == nil {
			return c, nil
		}
		return d.DialContext(ctx, "udp", "8.8.8.8:53")
	},
}

func resolveHostIP(ctx context.Context, host string) (net.IP, error) {
	return resolveHostIPWithFamily(ctx, host, "ip")
}

func resolveHostIPWithFamily(ctx context.Context, rawHost string, family string) (net.IP, error) {
	clean, err := ExtractMTRHost(rawHost)
	if err != nil {
		return nil, err
	}
	if ip := net.ParseIP(clean); ip != nil {
		if family == "ip6" && ip.To4() != nil {
			return nil, fmt.Errorf("expected IPv6 address for %s, got IPv4 %s", rawHost, ip.String())
		}
		if family == "ip4" && ip.To4() == nil {
			return nil, fmt.Errorf("expected IPv4 address for %s, got IPv6 %s", rawHost, ip.String())
		}
		return ip, nil
	}
	ips, err := net.DefaultResolver.LookupIP(ctx, family, clean)
	if err != nil || len(ips) == 0 {
		ips, err = fallbackPublicDNSResolver.LookupIP(ctx, family, clean)
		if err != nil || len(ips) == 0 {
			return nil, fmt.Errorf("resolve %s (%s): %w", clean, family, err)
		}
	}
	if family == "ip6" {
		for _, candidate := range ips {
			if candidate.To4() == nil && candidate.To16() != nil {
				return candidate.To16(), nil
			}
		}
		return nil, fmt.Errorf("no AAAA record found for %s", clean)
	}
	for _, candidate := range ips {
		if candidate.To4() != nil {
			return candidate, nil
		}
	}
	return ips[0], nil
}
