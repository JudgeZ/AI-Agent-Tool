package gateway

import "net/http"

const defaultMaxBodyBytes = int64(10 << 20) // 10 MiB

// DefaultMaxRequestBodyBytes returns the default request body size limit the
// gateway should apply when no override is provided.
func DefaultMaxRequestBodyBytes() int64 {
	return defaultMaxBodyBytes
}

// RequestBodyLimitMiddleware constrains the size of incoming request bodies by
// wrapping the request body with http.MaxBytesReader. When the limit is zero or
// negative the middleware simply forwards the request without modification.
func RequestBodyLimitMiddleware(next http.Handler, maxBytes int64) http.Handler {
	if maxBytes <= 0 {
		return next
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
		}
		next.ServeHTTP(w, r)
	})
}

// SecurityHeadersMiddleware ensures standard security headers are present on
// every response emitted by the gateway. Existing header values are preserved
// to allow route handlers to override them when necessary.
func SecurityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		headers := w.Header()

		if headers.Get("Content-Security-Policy") == "" {
			headers.Set("Content-Security-Policy", "default-src 'self'")
		}
		if headers.Get("Permissions-Policy") == "" {
			headers.Set("Permissions-Policy", "accelerometer=(), autoplay=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()")
		}
		if headers.Get("Referrer-Policy") == "" {
			headers.Set("Referrer-Policy", "no-referrer")
		}
		if headers.Get("Strict-Transport-Security") == "" {
			headers.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		}
		if headers.Get("X-Content-Type-Options") == "" {
			headers.Set("X-Content-Type-Options", "nosniff")
		}
		if headers.Get("X-Frame-Options") == "" {
			headers.Set("X-Frame-Options", "DENY")
		}
		if headers.Get("X-XSS-Protection") == "" {
			headers.Set("X-XSS-Protection", "0")
		}

		next.ServeHTTP(w, r)
	})
}
