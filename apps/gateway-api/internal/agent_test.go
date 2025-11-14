package agentpb

import (
	"reflect"
	"testing"

	"google.golang.org/protobuf/proto"
)

func TestToolInvocation_Getters(t *testing.T) {
	t.Parallel()

	original := &ToolInvocation{
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

	for _, tc := range []struct {
		name string
		got  func(*ToolInvocation) any
		want any
	}{
		{name: "InvocationId", got: func(m *ToolInvocation) any { return m.GetInvocationId() }, want: "inv-1"},
		{name: "PlanId", got: func(m *ToolInvocation) any { return m.GetPlanId() }, want: "plan-1"},
		{name: "StepId", got: func(m *ToolInvocation) any { return m.GetStepId() }, want: "step-1"},
		{name: "Tool", got: func(m *ToolInvocation) any { return m.GetTool() }, want: "tool-1"},
		{name: "Capability", got: func(m *ToolInvocation) any { return m.GetCapability() }, want: "capability-1"},
		{name: "CapabilityLabel", got: func(m *ToolInvocation) any { return m.GetCapabilityLabel() }, want: "Capability Label"},
		{name: "Labels", got: func(m *ToolInvocation) any { return m.GetLabels() }, want: []string{"a", "b"}},
		{name: "InputJson", got: func(m *ToolInvocation) any { return m.GetInputJson() }, want: "{}"},
		{name: "Metadata", got: func(m *ToolInvocation) any { return m.GetMetadata() }, want: map[string]string{"key": "value"}},
		{name: "TimeoutSeconds", got: func(m *ToolInvocation) any { return m.GetTimeoutSeconds() }, want: int32(30)},
		{name: "ApprovalRequired", got: func(m *ToolInvocation) any { return m.GetApprovalRequired() }, want: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Helper()
			got := tc.got(original)
			switch want := tc.want.(type) {
			case []string:
				if !reflect.DeepEqual(got, want) {
					t.Fatalf("%s = %#v, want %#v", tc.name, got, want)
				}
			case map[string]string:
				if !reflect.DeepEqual(got, want) {
					t.Fatalf("%s = %#v, want %#v", tc.name, got, want)
				}
			default:
				if got != want {
					t.Fatalf("%s = %#v, want %#v", tc.name, got, want)
				}
			}
		})
	}
}

func TestToolInvocation_GettersZeroValue(t *testing.T) {
	var msg ToolInvocation
	if msg.GetInvocationId() != "" {
		t.Fatalf("GetInvocationId() zero value = %q, want \"\"", msg.GetInvocationId())
	}
	if msg.GetPlanId() != "" {
		t.Fatalf("GetPlanId() zero value = %q, want \"\"", msg.GetPlanId())
	}
	if msg.GetStepId() != "" {
		t.Fatalf("GetStepId() zero value = %q, want \"\"", msg.GetStepId())
	}
	if msg.GetTool() != "" {
		t.Fatalf("GetTool() zero value = %q, want \"\"", msg.GetTool())
	}
	if msg.GetCapability() != "" {
		t.Fatalf("GetCapability() zero value = %q, want \"\"", msg.GetCapability())
	}
	if msg.GetCapabilityLabel() != "" {
		t.Fatalf("GetCapabilityLabel() zero value = %q, want \"\"", msg.GetCapabilityLabel())
	}
	if len(msg.GetLabels()) != 0 {
		t.Fatalf("len(GetLabels()) zero value = %d, want 0", len(msg.GetLabels()))
	}
	if msg.GetInputJson() != "" {
		t.Fatalf("GetInputJson() zero value = %q, want \"\"", msg.GetInputJson())
	}
	if len(msg.GetMetadata()) != 0 {
		t.Fatalf("len(GetMetadata()) zero value = %d, want 0", len(msg.GetMetadata()))
	}
	if msg.GetTimeoutSeconds() != 0 {
		t.Fatalf("GetTimeoutSeconds() zero value = %d, want 0", msg.GetTimeoutSeconds())
	}
	if msg.GetApprovalRequired() {
		t.Fatalf("GetApprovalRequired() zero value = true, want false")
	}
	if (*ToolInvocation)(nil).GetPlanId() != "" {
		t.Fatalf("nil receiver GetPlanId() = %q, want \"\"", (*ToolInvocation)(nil).GetPlanId())
	}
	if len((*ToolInvocation)(nil).GetMetadata()) != 0 {
		t.Fatalf("nil receiver len(GetMetadata()) = %d, want 0", len((*ToolInvocation)(nil).GetMetadata()))
	}
}

func TestToolInvocation_Clone(t *testing.T) {
	original := &ToolInvocation{
		InvocationId: "inv-1",
		Labels:       []string{"a", "b"},
		Metadata:     map[string]string{"key": "value"},
	}

	cloneMsg, ok := proto.Clone(original).(*ToolInvocation)
	if !ok {
		t.Fatalf("proto.Clone() type = %T, want *ToolInvocation", cloneMsg)
	}
	if !proto.Equal(original, cloneMsg) {
		t.Fatalf("proto.Equal(original, clone) = false, want true")
	}

	original.Labels[0] = "changed"
	original.Metadata["key"] = "changed"

	if reflect.DeepEqual(original.GetLabels(), cloneMsg.GetLabels()) {
		t.Fatalf("clone labels shared backing slice: got %v", cloneMsg.GetLabels())
	}
	if reflect.DeepEqual(original.GetMetadata(), cloneMsg.GetMetadata()) {
		t.Fatalf("clone metadata shared backing map: got %v", cloneMsg.GetMetadata())
	}
}

func TestToolInvocation_Descriptor(t *testing.T) {
	desc := (&ToolInvocation{}).ProtoReflect().Descriptor()
	if got := string(desc.FullName()); got != "agent.v1.ToolInvocation" {
		t.Fatalf("descriptor FullName() = %q, want %q", got, "agent.v1.ToolInvocation")
	}
}

func TestToolInvocation_Reset(t *testing.T) {
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

	msg.Reset()

	if msg.GetInvocationId() != "" {
		t.Fatalf("GetInvocationId() after Reset() = %q, want \"\"", msg.GetInvocationId())
	}
	if msg.GetPlanId() != "" {
		t.Fatalf("GetPlanId() after Reset() = %q, want \"\"", msg.GetPlanId())
	}
	if msg.GetStepId() != "" {
		t.Fatalf("GetStepId() after Reset() = %q, want \"\"", msg.GetStepId())
	}
	if msg.GetTool() != "" {
		t.Fatalf("GetTool() after Reset() = %q, want \"\"", msg.GetTool())
	}
	if msg.GetCapability() != "" {
		t.Fatalf("GetCapability() after Reset() = %q, want \"\"", msg.GetCapability())
	}
	if msg.GetCapabilityLabel() != "" {
		t.Fatalf("GetCapabilityLabel() after Reset() = %q, want \"\"", msg.GetCapabilityLabel())
	}
	if len(msg.GetLabels()) != 0 {
		t.Fatalf("GetLabels() after Reset() length = %d, want 0", len(msg.GetLabels()))
	}
	if msg.GetInputJson() != "" {
		t.Fatalf("GetInputJson() after Reset() = %q, want \"\"", msg.GetInputJson())
	}
	if len(msg.GetMetadata()) != 0 {
		t.Fatalf("GetMetadata() after Reset() length = %d, want 0", len(msg.GetMetadata()))
	}
	if msg.GetTimeoutSeconds() != 0 {
		t.Fatalf("GetTimeoutSeconds() after Reset() = %d, want 0", msg.GetTimeoutSeconds())
	}
	if msg.GetApprovalRequired() {
		t.Fatalf("GetApprovalRequired() after Reset() = true, want false")
	}
}

func TestToolEvent_Getters(t *testing.T) {
	t.Parallel()

	event := &ToolEvent{
		InvocationId: "inv-2",
		PlanId:       "plan-2",
		StepId:       "step-2",
		State:        "completed",
		Summary:      "done",
		OutputJson:   "{\"ok\":true}",
		OccurredAt:   "2025-11-14T12:00:00Z",
	}

	for _, tc := range []struct {
		name string
		got  func(*ToolEvent) any
		want any
	}{
		{name: "InvocationId", got: func(e *ToolEvent) any { return e.GetInvocationId() }, want: "inv-2"},
		{name: "PlanId", got: func(e *ToolEvent) any { return e.GetPlanId() }, want: "plan-2"},
		{name: "StepId", got: func(e *ToolEvent) any { return e.GetStepId() }, want: "step-2"},
		{name: "State", got: func(e *ToolEvent) any { return e.GetState() }, want: "completed"},
		{name: "Summary", got: func(e *ToolEvent) any { return e.GetSummary() }, want: "done"},
		{name: "OutputJson", got: func(e *ToolEvent) any { return e.GetOutputJson() }, want: "{\"ok\":true}"},
		{name: "OccurredAt", got: func(e *ToolEvent) any { return e.GetOccurredAt() }, want: "2025-11-14T12:00:00Z"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.got(event); got != tc.want {
				t.Fatalf("%s = %q, want %q", tc.name, got, tc.want)
			}
		})
	}
}

func TestToolEvent_GettersZeroValue(t *testing.T) {
	var event ToolEvent
	if event.GetInvocationId() != "" {
		t.Fatalf("GetInvocationId() zero value = %q, want \"\"", event.GetInvocationId())
	}
	if event.GetPlanId() != "" {
		t.Fatalf("GetPlanId() zero value = %q, want \"\"", event.GetPlanId())
	}
	if event.GetStepId() != "" {
		t.Fatalf("GetStepId() zero value = %q, want \"\"", event.GetStepId())
	}
	if event.GetState() != "" {
		t.Fatalf("GetState() zero value = %q, want \"\"", event.GetState())
	}
	if event.GetSummary() != "" {
		t.Fatalf("GetSummary() zero value = %q, want \"\"", event.GetSummary())
	}
	if event.GetOutputJson() != "" {
		t.Fatalf("GetOutputJson() zero value = %q, want \"\"", event.GetOutputJson())
	}
	if event.GetOccurredAt() != "" {
		t.Fatalf("GetOccurredAt() zero value = %q, want \"\"", event.GetOccurredAt())
	}
	if (*ToolEvent)(nil).GetSummary() != "" {
		t.Fatalf("nil receiver GetSummary() = %q, want \"\"", (*ToolEvent)(nil).GetSummary())
	}
}

func TestToolEvent_Clone(t *testing.T) {
	event := &ToolEvent{
		InvocationId: "inv-2",
		Summary:      "done",
		OutputJson:   "{\"ok\":true}",
	}

	cloneEvent, ok := proto.Clone(event).(*ToolEvent)
	if !ok {
		t.Fatalf("proto.Clone() type = %T, want *ToolEvent", cloneEvent)
	}
	if !proto.Equal(event, cloneEvent) {
		t.Fatalf("proto.Equal(event, clone) = false, want true")
	}

	event.Summary = "changed"
	event.OutputJson = "{}"

	if cloneEvent.GetSummary() != "done" {
		t.Fatalf("clone summary = %q, want %q", cloneEvent.GetSummary(), "done")
	}
	if cloneEvent.GetOutputJson() != "{\"ok\":true}" {
		t.Fatalf("clone output json = %q, want %q", cloneEvent.GetOutputJson(), "{\"ok\":true}")
	}
}

func TestToolEvent_Descriptor(t *testing.T) {
	desc := (&ToolEvent{}).ProtoReflect().Descriptor()
	if got := string(desc.FullName()); got != "agent.v1.ToolEvent" {
		t.Fatalf("descriptor FullName() = %q, want %q", got, "agent.v1.ToolEvent")
	}
}

func TestToolEvent_Reset(t *testing.T) {
	event := &ToolEvent{
		InvocationId: "inv-2",
		PlanId:       "plan-2",
		StepId:       "step-2",
		State:        "completed",
		Summary:      "done",
		OutputJson:   "{\"ok\":true}",
		OccurredAt:   "2025-11-14T12:00:00Z",
	}

	event.Reset()

	if event.GetInvocationId() != "" {
		t.Fatalf("GetInvocationId() after Reset() = %q, want \"\"", event.GetInvocationId())
	}
	if event.GetPlanId() != "" {
		t.Fatalf("GetPlanId() after Reset() = %q, want \"\"", event.GetPlanId())
	}
	if event.GetStepId() != "" {
		t.Fatalf("GetStepId() after Reset() = %q, want \"\"", event.GetStepId())
	}
	if event.GetState() != "" {
		t.Fatalf("GetState() after Reset() = %q, want \"\"", event.GetState())
	}
	if event.GetSummary() != "" {
		t.Fatalf("GetSummary() after Reset() = %q, want \"\"", event.GetSummary())
	}
	if event.GetOutputJson() != "" {
		t.Fatalf("GetOutputJson() after Reset() = %q, want \"\"", event.GetOutputJson())
	}
	if event.GetOccurredAt() != "" {
		t.Fatalf("GetOccurredAt() after Reset() = %q, want \"\"", event.GetOccurredAt())
	}
}
