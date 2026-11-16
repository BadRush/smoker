package auth

import (
	"crypto/tls"
	"net/http/httptest"
	"testing"
)

func TestShouldUseSecureCookie(t *testing.T) {
	t.Parallel()

	plainReq := httptest.NewRequest("GET", "http://smoker.local/", nil)
	if ShouldUseSecureCookie("auto", plainReq) {
		t.Fatalf("expected auto + plain HTTP without X-Forwarded-Proto to be false")
	}

	proxyTLSReq := httptest.NewRequest("GET", "http://gateway/", nil)
	proxyTLSReq.Header.Set("X-Forwarded-Proto", "https")
	if !ShouldUseSecureCookie("auto", proxyTLSReq) {
		t.Fatalf("expected auto + X-Forwarded-Proto=https to be true")
	}

	directTLSReq := httptest.NewRequest("GET", "https://smoker.local/", nil)
	directTLSReq.TLS = &tls.ConnectionState{}
	if !ShouldUseSecureCookie("auto", directTLSReq) {
		t.Fatalf("expected auto + r.TLS to be true")
	}

	if ShouldUseSecureCookie("false", proxyTLSReq) {
		t.Fatalf("expected forced false to override X-Forwarded-Proto")
	}
	if !ShouldUseSecureCookie("true", plainReq) {
		t.Fatalf("expected forced true to return true")
	}
}

func TestClientIPPrecedence(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest("POST", "/api/auth/login", nil)
	req.RemoteAddr = "172.18.0.5:43210"
	req.Header.Set("X-Real-IP", "10.0.0.2")
	req.Header.Set("X-Forwarded-For", "198.51.100.4, 10.0.0.2")
	req.Header.Set("CF-Connecting-IP", "2001:db8::42")

	if got := clientIP(req); got != "2001:db8::42" {
		t.Fatalf("clientIP with CF-Connecting-IP = %q, want 2001:db8::42", got)
	}

	req.Header.Del("CF-Connecting-IP")
	if got := clientIP(req); got != "198.51.100.4" {
		t.Fatalf("clientIP with X-Forwarded-For = %q, want 198.51.100.4", got)
	}

	req.Header.Del("X-Forwarded-For")
	if got := clientIP(req); got != "10.0.0.2" {
		t.Fatalf("clientIP with X-Real-IP = %q, want 10.0.0.2", got)
	}

	req.Header.Del("X-Real-IP")
	if got := clientIP(req); got != "172.18.0.5" {
		t.Fatalf("clientIP with RemoteAddr = %q, want 172.18.0.5", got)
	}
}
