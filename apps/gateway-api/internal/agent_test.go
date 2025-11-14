package agentpb

import (
	"reflect"
	"testing"

	"google.golang.org/protobuf/proto"
)

func TestToolInvocationProtoLifecycle(t *testing.T) {
	msg := &ToolInvocation{
		InvocationId:     "inv-1",
		PlanId:           "plan-1",
		StepId:           "step-1",
		Tool:             "tool-1",
		Capability:       "capability-1",
		CapabilityLabel:  "Capability Label",
		Labels:           []string{"a", "b"},
		InputJson:        "{}",
		Metadata:         map[string]string{"key": "value"},
		TimeoutSeconds:   30,
		ApprovalRequired: true,
	}

	if !proto.Equal(msg, proto.Clone(msg)) {
		t.Fatalf("expected proto clone to match original message")
	}

	if got := msg.GetInvocationId(); got != "inv-1" {
		t.Fatalf("unexpected invocation id: %s", got)
	}
	if got := msg.GetPlanId(); got != "plan-1" {
		t.Fatalf("unexpected plan id: %s", got)
	}
	if got := msg.GetStepId(); got != "step-1" {
		t.Fatalf("unexpected step id: %s", got)
	}
	if got := msg.GetTool(); got != "tool-1" {
		t.Fatalf("unexpected tool: %s", got)
	}
	if got := msg.GetCapability(); got != "capability-1" {
		t.Fatalf("unexpected capability: %s", got)
	}
	if got := msg.GetCapabilityLabel(); got != "Capability Label" {
		t.Fatalf("unexpected capability label: %s", got)
	}
	if !reflect.DeepEqual(msg.GetLabels(), []string{"a", "b"}) {
		t.Fatalf("unexpected labels: %#v", msg.GetLabels())
	}
	if got := msg.GetInputJson(); got != "{}" {
		t.Fatalf("unexpected input json: %s", got)
	}
	if !reflect.DeepEqual(msg.GetMetadata(), map[string]string{"key": "value"}) {
		t.Fatalf("unexpected metadata: %#v", msg.GetMetadata())
	}
	if got := msg.GetTimeoutSeconds(); got != 30 {
		t.Fatalf("unexpected timeout: %d", got)
	}
	if !msg.GetApprovalRequired() {
		t.Fatalf("expected approval required flag to be true")
	}

	// Ensure the message exposes descriptor metadata without panicking.
	desc := msg.ProtoReflect().Descriptor()
	if desc.FullName() == "" {
		t.Fatalf("expected descriptor to have a full name")
	}

	msg.Reset()
	if msg.GetInvocationId() != "" {
		t.Fatalf("expected reset message to clear fields")
	}
}

func TestToolEventProtoLifecycle(t *testing.T) {
	event := &ToolEvent{
		InvocationId: "inv-2",
		PlanId:       "plan-2",
		StepId:       "step-2",
		State:        "completed",
		Summary:      "done",
		OutputJson:   "{\"ok\":true}",
		OccurredAt:   "2025-11-14T12:00:00Z",
	}

	if !proto.Equal(event, proto.Clone(event)) {
		t.Fatalf("expected proto clone to match original event")
	}

	if event.GetInvocationId() != "inv-2" {
		t.Fatalf("unexpected invocation id: %s", event.GetInvocationId())
	}
	if event.GetPlanId() != "plan-2" {
		t.Fatalf("unexpected plan id: %s", event.GetPlanId())
	}
	if event.GetStepId() != "step-2" {
		t.Fatalf("unexpected step id: %s", event.GetStepId())
	}
	if event.GetState() != "completed" {
		t.Fatalf("unexpected state: %s", event.GetState())
	}
	if event.GetSummary() != "done" {
		t.Fatalf("unexpected summary: %s", event.GetSummary())
	}
	if event.GetOutputJson() != "{\"ok\":true}" {
		t.Fatalf("unexpected output json: %s", event.GetOutputJson())
	}
	if event.GetOccurredAt() != "2025-11-14T12:00:00Z" {
		t.Fatalf("unexpected occurredAt: %s", event.GetOccurredAt())
	}

	// Exercise descriptor helpers.
	desc := event.ProtoReflect().Descriptor()
	if desc.FullName() == "" {
		t.Fatalf("expected descriptor to expose a name")
	}

	event.Reset()
	if event.GetInvocationId() != "" {
		t.Fatalf("expected reset event to clear fields")
	}
}
