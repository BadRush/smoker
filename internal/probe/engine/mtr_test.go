package engine

import (
	"context"
	"encoding/binary"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestExtractMTRHost(t *testing.T) {
	t.Parallel()

	cases := []struct {
		in   string
		want string
	}{
		{"https://www.google.com/generate_204", "www.google.com"},
		{"http://example.org:8080/health", "example.org"},
		{"1.1.1.1:53", "1.1.1.1"},
		{"[2001:4860:4860::8888]:443", "2001:4860:4860::8888"},
		{"2001:4860:4860::8888", "2001:4860:4860::8888"},
		{"8.8.8.8", "8.8.8.8"},
		{"  e1-vhp.com/status  ", "e1-vhp.com"},
	}

	for _, tc := range cases {
		got, err := ExtractMTRHost(tc.in)
		if err != nil {
			t.Fatalf("ExtractMTRHost(%q) unexpected err: %v", tc.in, err)
		}
		if got != tc.want {
			t.Errorf("ExtractMTRHost(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}

	if _, err := ExtractMTRHost("   "); err == nil {
		t.Fatalf("expected error for blank host")
	}
}

func TestTrimCutoffTTL(t *testing.T) {
	t.Parallel()

	if got := trimCutoffTTL(30, 11, 11); got != 11 {
		t.Errorf("dest reached cutoff = %d, want 11", got)
	}
	if got := trimCutoffTTL(30, 0, 6); got != 8 {
		t.Errorf("mid-path drop cutoff = %d, want 8", got)
	}
	if got := trimCutoffTTL(30, 0, 0); got != 3 {
		t.Errorf("all-timeout cutoff = %d, want 3", got)
	}
}

func TestNextMTRICMPIDConcurrentUnique(t *testing.T) {
	t.Parallel()

	const n = 256
	ids := make(map[int]bool, n)
	var mu sync.Mutex
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id := nextMTRICMPID()
			mu.Lock()
			if id == 0 {
				t.Errorf("got zero icmp id")
			}
			ids[id] = true
			mu.Unlock()
		}()
	}
	wg.Wait()
	if len(ids) != n {
		t.Fatalf("expected %d unique concurrent icmp IDs, got %d", n, len(ids))
	}
}

func TestExtractOriginalICMPSeq(t *testing.T) {
	t.Parallel()

	// IPv4: 20-byte IPv4 header (IHL=5) + 8-byte ICMP echo header
	pkt4 := make([]byte, 28)
	pkt4[0] = 0x45
	binary.BigEndian.PutUint16(pkt4[24:26], 0x1234)
	binary.BigEndian.PutUint16(pkt4[26:28], 42)

	id, seq, ok := ExtractOriginalICMPSeq(pkt4)
	if !ok || id != 0x1234 || seq != 42 {
		t.Fatalf("IPv4 ExtractOriginalICMPSeq = (%x, %d, %v), want (1234, 42, true)", id, seq, ok)
	}

	// IPv6: 40-byte IPv6 header + 8-byte ICMPv6 echo header
	pkt6 := make([]byte, 48)
	pkt6[0] = 0x60
	binary.BigEndian.PutUint16(pkt6[44:46], 0xABCD)
	binary.BigEndian.PutUint16(pkt6[46:48], 99)

	id6, seq6, ok6 := ExtractOriginalICMPSeq(pkt6)
	if !ok6 || id6 != 0xABCD || seq6 != 99 {
		t.Fatalf("IPv6 ExtractOriginalICMPSeq = (%x, %d, %v), want (abcd, 99, true)", id6, seq6, ok6)
	}

	if _, _, ok := ExtractOriginalICMPSeq([]byte{0x45, 0x00}); ok {
		t.Fatalf("expected truncated packet to return ok=false")
	}
}

func TestIPv6ProberFormattingAndResolution(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	// Bare IPv6 literal in HTTP target URL gets bracketed automatically
	gotURL := formatHTTPTargetURL("2606:4700:4700::1111", "/cdn-cgi/trace")
	if gotURL != "https://[2606:4700:4700::1111]/cdn-cgi/trace" {
		t.Fatalf("formatHTTPTargetURL bare IPv6 = %q, want https://[2606:4700:4700::1111]/cdn-cgi/trace", gotURL)
	}

	// DNS6 server address resolution handles bare IPv6, bracketed IPv6, and rejects IPv4 literal
	addr, proto, err := resolveDNSServerAddr(ctx, "2001:4860:4860::8888", true)
	if err != nil || addr != "[2001:4860:4860::8888]:53" || proto != "udp6" {
		t.Fatalf("resolveDNSServerAddr v6 = (%q, %q, %v), want ([2001:4860:4860::8888]:53, udp6, nil)", addr, proto, err)
	}
	if _, _, err := resolveDNSServerAddr(ctx, "8.8.8.8", true); err == nil {
		t.Fatalf("expected resolveDNSServerAddr(8.8.8.8, forceV6=true) to fail")
	}

	// resolveHostIPWithFamily("ip6") accepts bracketed/bare IPv6 and rejects IPv4
	ip6, err := resolveHostIPWithFamily(ctx, "[2606:4700:4700::1111]", "ip6")
	if err != nil || ip6.String() != "2606:4700:4700::1111" {
		t.Fatalf("resolveHostIPWithFamily ip6 = (%v, %v)", ip6, err)
	}
	if _, err := resolveHostIPWithFamily(ctx, "1.1.1.1", "ip6"); err == nil {
		t.Fatalf("expected resolveHostIPWithFamily(1.1.1.1, ip6) to fail")
	}
}

func TestSourceIPBindingAndRandomICMPID(t *testing.T) {
	t.Parallel()

	// Multiple calls produce non-zero random ICMP IDs (never stuck on PID 1)
	seen := make(map[int]bool, 32)
	for i := 0; i < 32; i++ {
		id := randomICMPID()
		if id <= 0 || id > 0xffff {
			t.Fatalf("invalid icmpID: %d", id)
		}
		seen[id] = true
	}
	if len(seen) < 16 {
		t.Fatalf("expected high entropy across 32 randomICMPID calls, only got %d unique", len(seen))
	}

	opts := ProberOptions{SourceIP4: net.ParseIP("127.0.0.1")}

	// Test TCP source IP bind against local listener
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen tcp4: %v", err)
	}
	defer ln.Close()

	remoteCh := make(chan string, 1)
	go func() {
		conn, acceptErr := ln.Accept()
		if acceptErr == nil {
			remoteCh <- conn.RemoteAddr().String()
			_ = conn.Close()
		}
	}()

	_, port, _ := net.SplitHostPort(ln.Addr().String())
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	if _, err := ProbeTCPWithOptions(ctx, "tcp", "127.0.0.1", port, time.Second, opts); err != nil {
		t.Fatalf("ProbeTCPWithOptions failed: %v", err)
	}
	gotTCPPeer := <-remoteCh
	if !strings.HasPrefix(gotTCPPeer, "127.0.0.1:") {
		t.Fatalf("expected TCP remote addr from 127.0.0.1, got %s", gotTCPPeer)
	}

	// Test HTTP source IP bind against local HTTP server
	var gotHTTPPeer string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHTTPPeer = r.RemoteAddr
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	if _, err := ProbeHTTPWithOptions(ctx, "tcp", srv.URL, "", time.Second, opts); err != nil {
		t.Fatalf("ProbeHTTPWithOptions failed: %v", err)
	}
	if !strings.HasPrefix(gotHTTPPeer, "127.0.0.1:") {
		t.Fatalf("expected HTTP remote addr from 127.0.0.1, got %s", gotHTTPPeer)
	}

	// Test binding two ICMP probers to loopback simultaneously when kernel allows ICMP sockets
	p1, err1 := NewICMPProberWithOptions(opts)
	if err1 == nil {
		defer p1.Close()
		p2, err2 := NewICMPProberWithOptions(opts)
		if err2 != nil {
			t.Fatalf("expected second ICMPProber bound to 127.0.0.1 to open cleanly, got: %v", err2)
		}
		defer p2.Close()
	}
}
