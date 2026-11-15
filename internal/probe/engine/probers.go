package engine

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/miekg/dns"
)

func ProbeTCP(ctx context.Context, host, port string, timeout time.Duration) (time.Duration, error) {
	addr := net.JoinHostPort(host, strings.TrimSpace(port))
	dialer := net.Dialer{Timeout: timeout}
	start := time.Now()
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return 0, err
	}
	rtt := time.Since(start)
	_ = conn.Close()
	return rtt, nil
}

func ProbeHTTP(ctx context.Context, host, portOrPath string, timeout time.Duration) (time.Duration, error) {
	targetURL := strings.TrimSpace(host)
	if !strings.HasPrefix(targetURL, "http://") && !strings.HasPrefix(targetURL, "https://") {
		path := strings.TrimSpace(portOrPath)
		if path != "" && !strings.HasPrefix(path, "/") {
			path = "/" + path
		}
		targetURL = "https://" + targetURL + path
	} else if portOrPath != "" && !strings.Contains(strings.TrimPrefix(strings.TrimPrefix(targetURL, "https://"), "http://"), "/") {
		if !strings.HasPrefix(portOrPath, "/") {
			portOrPath = "/" + portOrPath
		}
		targetURL += portOrPath
	}

	tr := &http.Transport{
		DisableKeepAlives: true,
		TLSClientConfig:   &tls.Config{MinVersion: tls.VersionTLS12},
	}
	defer tr.CloseIdleConnections()

	client := &http.Client{
		Timeout:   timeout,
		Transport: tr,
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("User-Agent", "Smoker-Probe/1.0")

	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	_ = resp.Body.Close()
	rtt := time.Since(start)

	if resp.StatusCode >= 400 {
		return 0, fmt.Errorf("http status %d", resp.StatusCode)
	}
	return rtt, nil
}

func ProbeDNS(ctx context.Context, resolverHost, portOrPath string, timeout time.Duration) (time.Duration, error) {
	domain := "example.com."
	qtype := dns.TypeA
	if raw := strings.TrimSpace(portOrPath); raw != "" {
		parts := strings.SplitN(raw, "|", 2)
		if parts[0] != "" {
			domain = dns.Fqdn(strings.TrimSpace(parts[0]))
		}
		if len(parts) == 2 {
			switch strings.ToUpper(strings.TrimSpace(parts[1])) {
			case "AAAA":
				qtype = dns.TypeAAAA
			case "TXT":
				qtype = dns.TypeTXT
			case "MX":
				qtype = dns.TypeMX
			}
		}
	}

	addr := resolverHost
	if _, _, err := net.SplitHostPort(addr); err != nil {
		addr = net.JoinHostPort(resolverHost, "53")
	}

	m := new(dns.Msg)
	m.SetQuestion(domain, qtype)
	m.RecursionDesired = true

	client := &dns.Client{
		Net:     "udp",
		Timeout: timeout,
	}
	resp, rtt, err := client.ExchangeContext(ctx, m, addr)
	if err != nil {
		return 0, err
	}
	if resp.Rcode != dns.RcodeSuccess && resp.Rcode != dns.RcodeNameError {
		return 0, fmt.Errorf("dns rcode %s", dns.RcodeToString[resp.Rcode])
	}
	return rtt, nil
}
