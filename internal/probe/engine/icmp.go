package engine

import (
	"context"
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

type icmpSocket struct {
	conn   *icmp.PacketConn
	isRaw  bool
	isV6   bool
	icmpID int
	seq    atomic.Uint32
	waiters sync.Map // uint16 -> chan time.Time
}

func openICMPSocket(isV6 bool) (*icmpSocket, error) {
	network := "ip4:icmp"
	fallback := "udp4"
	addr := "0.0.0.0"
	if isV6 {
		network = "ip6:ipv6-icmp"
		fallback = "udp6"
		addr = "::"
	}

	isRaw := true
	conn, err := icmp.ListenPacket(network, addr)
	if err != nil {
		isRaw = false
		conn, err = icmp.ListenPacket(fallback, addr)
		if err != nil {
			return nil, fmt.Errorf("listen %s/%s: %w", network, fallback, err)
		}
	}

	s := &icmpSocket{
		conn:   conn,
		isRaw:  isRaw,
		isV6:   isV6,
		icmpID: os.Getpid() & 0xffff,
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
	v4 *icmpSocket
	v6 *icmpSocket
}

func NewICMPProber() (*ICMPProber, error) {
	v4, err := openICMPSocket(false)
	if err != nil {
		return nil, err
	}
	v6, _ := openICMPSocket(true) // Best-effort IPv6
	return &ICMPProber{v4: v4, v6: v6}, nil
}

func (p *ICMPProber) Close() {
	if p.v4 != nil {
		_ = p.v4.Close()
	}
	if p.v6 != nil {
		_ = p.v6.Close()
	}
}

func (p *ICMPProber) Ping(ctx context.Context, host string, timeout time.Duration) (time.Duration, error) {
	ip, err := resolveHostIP(ctx, host)
	if err != nil {
		return 0, err
	}
	if ip.To4() != nil {
		return p.v4.ping(ctx, ip.To4(), timeout)
	}
	if p.v6 == nil {
		return 0, fmt.Errorf("ipv6 icmp unavailable")
	}
	return p.v6.ping(ctx, ip, timeout)
}

func resolveHostIP(ctx context.Context, host string) (net.IP, error) {
	if ip := net.ParseIP(host); ip != nil {
		return ip, nil
	}
	ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
	if err != nil || len(ips) == 0 {
		return nil, fmt.Errorf("resolve %s: %w", host, err)
	}
	for _, candidate := range ips {
		if candidate.To4() != nil {
			return candidate, nil
		}
	}
	return ips[0], nil
}
