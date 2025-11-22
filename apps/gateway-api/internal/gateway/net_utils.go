package gateway

import (
	"fmt"
	"net"
	"net/http"
	"strings"
)

func ClientIP(r *http.Request, trustedProxies []*net.IPNet) string {
	remoteAddr := strings.TrimSpace(r.RemoteAddr)
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	remoteIP := net.ParseIP(host)

	if remoteIP != nil && IsTrustedProxy(remoteIP, trustedProxies) {
		if forwarded := ExtractClientIPFromForwardedFor(r.Header.Get("X-Forwarded-For"), trustedProxies); forwarded != nil {
			return forwarded.String()
		}
		if real := ExtractClientIP(strings.TrimSpace(r.Header.Get("X-Real-IP")), trustedProxies); real != nil {
			return real.String()
		}
		return remoteIP.String()
	}
	if remoteIP != nil {
		return remoteIP.String()
	}
	return host
}

func RequestRemoteIP(r *http.Request) net.IP {
	remoteAddr := strings.TrimSpace(r.RemoteAddr)
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	if host == "" {
		return nil
	}
	return net.ParseIP(host)
}

func ExtractClientIP(candidate string, trustedProxies []*net.IPNet) net.IP {
	if candidate == "" {
		return nil
	}
	ip := net.ParseIP(candidate)
	if ip == nil {
		return nil
	}
	if IsTrustedProxy(ip, trustedProxies) {
		return nil
	}
	return ip
}

func ExtractClientIPFromForwardedFor(header string, trustedProxies []*net.IPNet) net.IP {
	if header == "" {
		return nil
	}
	parts := strings.Split(header, ",")
	for i := len(parts) - 1; i >= 0; i-- {
		candidate := strings.TrimSpace(parts[i])
		if candidate == "" {
			continue
		}
		ip := net.ParseIP(candidate)
		if ip == nil {
			continue
		}
		if !IsTrustedProxy(ip, trustedProxies) {
			return ip
		}
	}
	return nil
}

func IsTrustedProxy(ip net.IP, trusted []*net.IPNet) bool {
	if ip == nil {
		return false
	}
	for _, network := range trusted {
		if network != nil && network.Contains(ip) {
			return true
		}
	}
	return false
}

func ParseTrustedProxyCIDRs(entries []string) ([]*net.IPNet, error) {
	if len(entries) == 0 {
		return nil, nil
	}
	proxies := make([]*net.IPNet, 0, len(entries))
	for _, entry := range entries {
		token := strings.TrimSpace(entry)
		if token == "" {
			continue
		}
		if strings.Contains(token, "/") {
			_, network, err := net.ParseCIDR(token)
			if err != nil {
				return nil, fmt.Errorf("invalid CIDR %q: %w", token, err)
			}
			proxies = append(proxies, network)
			continue
		}
		ip := net.ParseIP(token)
		if ip == nil {
			return nil, fmt.Errorf("invalid IP %q", token)
		}
		if ipv4 := ip.To4(); ipv4 != nil {
			mask := net.CIDRMask(net.IPv4len*8, net.IPv4len*8)
			proxies = append(proxies, &net.IPNet{IP: ipv4, Mask: mask})
			continue
		}
		mask := net.CIDRMask(net.IPv6len*8, net.IPv6len*8)
		proxies = append(proxies, &net.IPNet{IP: ip, Mask: mask})
	}
	if len(proxies) == 0 {
		return nil, nil
	}
	return proxies, nil
}

func ForwardedProto(r *http.Request) (string, bool) {
	headers := []string{"X-Forwarded-Proto", "X-Forwarded-Protocol", "X-Url-Scheme"}
	for _, header := range headers {
		if value := strings.TrimSpace(r.Header.Get(header)); value != "" {
			return value, true
		}
	}
	if ssl := strings.TrimSpace(r.Header.Get("X-Forwarded-Ssl")); ssl != "" {
		if strings.EqualFold(ssl, "on") || ssl == "1" || strings.EqualFold(ssl, "enabled") {
			return "https", true
		}
		return "http", true
	}
	for _, forwarded := range r.Header.Values("Forwarded") {
		directives := strings.Split(forwarded, ";")
		for _, directive := range directives {
			kv := strings.SplitN(strings.TrimSpace(directive), "=", 2)
			if len(kv) != 2 {
				continue
			}
			if strings.EqualFold(kv[0], "proto") {
				value := strings.Trim(strings.TrimSpace(kv[1]), "\"")
				if value != "" {
					return value, true
				}
			}
		}
	}
	return "", false
}

func LocalIP(r *http.Request) string {
	addrVal := r.Context().Value(http.LocalAddrContextKey)
	if addrVal == nil {
		return ""
	}
	netAddr, ok := addrVal.(net.Addr)
	if !ok || netAddr == nil {
		return ""
	}
	host, _, err := net.SplitHostPort(netAddr.String())
	if err != nil {
		return strings.TrimSpace(netAddr.String())
	}
	return strings.TrimSpace(host)
}

func CloneHeaders(dst, src http.Header, headers []string) {
	if len(headers) == 0 {
		return
	}
	for _, header := range headers {
		values := src.Values(header)
		if len(values) == 0 {
			continue
		}
		dst.Del(header)
		for _, value := range values {
			if value == "" {
				continue
			}
			dst.Add(header, value)
		}
	}
}

func AppendAddressIfMissing(values []string, addr string) []string {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return values
	}
	for _, existing := range values {
		if existing == addr {
			return values
		}
	}
	return append(values, addr)
}

func UniqueHeaderValues(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(values))
	normalized := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		parts := strings.Split(value, ",")
		for _, part := range parts {
			token := strings.TrimSpace(part)
			if token == "" {
				continue
			}
			if _, ok := seen[token]; ok {
				continue
			}
			seen[token] = struct{}{}
			normalized = append(normalized, token)
		}
	}
	return normalized
}

func IsRequestSecure(r *http.Request, trustedProxies []*net.IPNet) bool {
	if r.TLS != nil {
		return true
	}
	proto, ok := ForwardedProto(r)
	if !ok {
		return false
	}
	remoteIP := RequestRemoteIP(r)
	if !IsTrustedProxy(remoteIP, trustedProxies) {
		return false
	}
	return strings.EqualFold(proto, "https")
}
