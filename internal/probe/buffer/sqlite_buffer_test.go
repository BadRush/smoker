package buffer

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"smoker/internal/protocol"
)

func TestSQLiteBufferStoreAndForward(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "buffer.db")

	buf, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open() failed: %v", err)
	}
	defer buf.Close()

	rtt1 := int32(12400)
	rtt2 := int32(15800)
	now := time.Now().UTC()

	samples := []protocol.SampleRecord{
		{TimestampNs: now.Add(-3 * time.Second).UnixNano(), TargetID: "t1", RTTUs: &rtt1, JitterUs: 100, IsLoss: false},
		{TimestampNs: now.Add(-2 * time.Second).UnixNano(), TargetID: "t1", RTTUs: nil, JitterUs: 0, IsLoss: true},
		{TimestampNs: now.Add(-1 * time.Second).UnixNano(), TargetID: "t1", RTTUs: &rtt2, JitterUs: 3400, IsLoss: false},
	}

	if err := buf.EnqueueSamples(ctx, samples); err != nil {
		t.Fatalf("EnqueueSamples() failed: %v", err)
	}

	cnt, err := buf.CountSamples(ctx)
	if err != nil || cnt != 3 {
		t.Fatalf("CountSamples() = %d, %v; want 3", cnt, err)
	}

	maxID, peeked, err := buf.PeekSamples(ctx, 2)
	if err != nil {
		t.Fatalf("PeekSamples() failed: %v", err)
	}
	if len(peeked) != 2 {
		t.Fatalf("len(peeked) = %d, want 2", len(peeked))
	}
	if !peeked[1].IsLoss || peeked[1].RTTUs != nil {
		t.Fatalf("expected second sample to be loss with nil RTT")
	}

	if err := buf.AckSamplesUpTo(ctx, maxID); err != nil {
		t.Fatalf("AckSamplesUpTo() failed: %v", err)
	}

	cnt, err = buf.CountSamples(ctx)
	if err != nil || cnt != 1 {
		t.Fatalf("CountSamples() after partial ack = %d, %v; want 1", cnt, err)
	}

	// EnforceRetention removes samples older than maxHours
	old := now.Add(-48 * time.Hour)
	if err := buf.EnqueueSamples(ctx, []protocol.SampleRecord{
		{TimestampNs: old.UnixNano(), TargetID: "t1", RTTUs: &rtt1, IsLoss: false},
	}); err != nil {
		t.Fatalf("Enqueue old sample failed: %v", err)
	}
	if err := buf.EnforceRetention(ctx, 24, 100, now); err != nil {
		t.Fatalf("EnforceRetention() failed: %v", err)
	}
	cnt, err = buf.CountSamples(ctx)
	if err != nil || cnt != 1 {
		t.Fatalf("CountSamples() after retention = %d, %v; want 1", cnt, err)
	}
}
