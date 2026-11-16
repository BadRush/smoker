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
	return ProbeTCPWithNetwork(ctx, "tcp", host, port, timeout)
}

func ProbeTCPWithNetwork(ctx context.Context, network, host, port string, timeout time.Duration) (time.Duration, error) {
	cleanHost, err := ExtractMTRHost(host)
	if err != nil {
		return 0, err
	}
	if network == "tcp6" {
		if ip := net.ParseIP(cleanHost); ip != nil && ip.To4() != nil {
			return 0, fmt.Errorf("tcp6 requires IPv6 target, got IPv4 %s", cleanHost)
		}
	}
	addr := net.JoinHostPort(cleanHost, strings.TrimSpace(port))
	dialer := net.Dialer{Timeout: timeout}
	start := time.Now()
	conn, err := dialer.DialContext(ctx, network, addr)
	if err != nil {
		return 0, err
	}
	rtt := time.Since(start)
	_ = conn.Close()
	return rtt, nil
}

func formatHTTPTargetURL(rawHost, portOrPath string) string {
	targetURL := strings.TrimSpace(rawHost)
	if !strings.HasPrefix(targetURL, "http://") && !strings.HasPrefix(targetURL, "https://") {
		unbracketed := strings.TrimSuffix(strings.TrimPrefix(targetURL, "["), "]")
		if ip := net.ParseIP(unbracketed); ip != nil && ip.To4() == nil {
			targetURL = "[" + unbracketed + "]"
		}
		path := strings.TrimSpace(portOrPath)
		if path != "" && !strings.HasPrefix(path, "/") {
			path = "/" + path
		}
		return "https://" + targetURL + path
	}
	if portOrPath != "" && !strings.Contains(strings.TrimPrefix(strings.TrimPrefix(targetURL, "https://"), "http://"), "/") {
		p := strings.TrimSpace(portOrPath)
		if p != "" {
			if !strings.HasPrefix(p, "/") {
				p = "/" + p
			}
			targetURL += p
		}
	}
	return targetURL
}

func ProbeHTTP(ctx context.Context, host, portOrPath string, timeout time.Duration) (time.Duration, error) {
	return ProbeHTTPWithNetwork(ctx, "tcp", host, portOrPath, timeout)
}

func ProbeHTTPWithNetwork(ctx context.Context, network, host, portOrPath string, timeout time.Duration) (time.Duration, error) {
	targetURL := formatHTTPTargetURL(host, portOrPath)
	dialer := &net.Dialer{Timeout: timeout}
	tr := &http.Transport{
		DisableKeepAlives: true,
		TLSClientConfig:   &tls.Config{MinVersion: tls.VersionTLS12},
		DialContext: func(dialCtx context.Context, _, addr string) (net.Conn, error) {
			if network == "tcp6" {
				if h, _, splitErr := net.SplitHostPort(addr); splitErr == nil {
					if ip := net.ParseIP(strings.TrimSuffix(strings.TrimPrefix(h, "["), "]")); ip != nil && ip.To4() != nil {
						return nil, fmt.Errorf("http6 requires IPv6 endpoint, got IPv4 %s", h)
					}
				}
			}
			return dialer.DialContext(dialCtx, network, addr)
		},
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

func resolveDNSServerAddr(ctx context.Context, rawHost string, forceV6 bool) (addr string, netProto string, err error) {
	s := strings.TrimSpace(rawHost)
	if s == "" {
		return "", "", fmt.Errorf("empty dns resolver host")
	}

	unbracketed := strings.TrimSuffix(strings.TrimPrefix(s, "["), "]")
	if ip := net.ParseIP(unbracketed); ip != nil {
		if forceV6 && ip.To4() != nil {
			return "", "", fmt.Errorf("dns6 requires IPv6 resolver, got IPv4 %s", unbracketed)
		}
		if ip.To4() == nil {
			return net.JoinHostPort(unbracketed, "53"), "udp6", nil
		}
		return net.JoinHostPort(unbracketed, "53"), "udp4", nil
	}

	hostPart := s
	portPart := "53"
	if h, p, splitErr := net.SplitHostPort(s); splitErr == nil && strings.TrimSpace(h) != "" {
		hostPart = strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(h), "["), "]")
		if strings.TrimSpace(p) != "" {
			portPart = strings.TrimSpace(p)
		}
	}

	family := "ip"
	if forceV6 {
		family = "ip6"
	}
	ip, err := resolveHostIPWithFamily(ctx, hostPart, family)
	if err != nil {
		return "", "", err
	}
	if ip.To4() == nil {
		return net.JoinHostPort(ip.String(), portPart), "udp6", nil
	}
	return net.JoinHostPort(ip.String(), portPart), "udp4", nil
}

func ProbeDNS(ctx context.Context, resolverHost, portOrPath string, timeout time.Duration) (time.Duration, error) {
	return ProbeDNSWithFamily(ctx, false, resolverHost, portOrPath, timeout)
}

func ProbeDNSWithFamily(ctx context.Context, forceV6 bool, resolverHost, portOrPath string, timeout time.Duration) (time.Duration, error) {
	domain := "example.com."
	qtype := dns.TypeA
	if forceV6 {
		qtype = dns.TypeAAAA
	}
	if raw := strings.TrimSpace(portOrPath); raw != "" {
		parts := strings.SplitN(raw, "|", 2)
		if parts[0] != "" {
			domain = dns.Fqdn(strings.TrimSpace(parts[0]))
		}
		if len(parts) == 2 {
			switch strings.ToUpper(strings.TrimSpace(parts[1])) {
			case "A":
				qtype = dns.TypeA
			case "AAAA":
				qtype = dns.TypeAAAA
			case "TXT":
				qtype = dns.TypeTXT
			case "MX":
				qtype = dns.TypeMX
			}
		}
	}

	addr, netProto, err := resolveDNSServerAddr(ctx, resolverHost, forceV6)
	if err != nil {
		return 0, err
	}

	m := new(dns.Msg)
	m.SetQuestion(domain, qtype)
	m.RecursionDesired = true

	client := &dns.Client{
		Net:     netProto,
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
