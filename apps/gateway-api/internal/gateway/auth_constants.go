package gateway

import (
	"time"
)

var orchestratorTimeout = GetDurationEnv("ORCHESTRATOR_CALLBACK_TIMEOUT", 10*time.Second)
