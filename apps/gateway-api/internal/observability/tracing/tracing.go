package tracing

import "context"

// Init initialises tracing for the gateway API. For now this is a no-op that
// returns a shutdown function to satisfy the call sites without requiring a
// telemetry backend during local development.
func Init(context.Context) (func(context.Context) error, error) {
	return func(context.Context) error { return nil }, nil
}
