package buffer

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"time"

	_ "modernc.org/sqlite"
	"smoker/internal/protocol"
)

type SQLiteBuffer struct {
	db     *sql.DB
	dbPath string
}

type QueuedMTR struct {
	ID      int64
	Payload protocol.MTRResultPayload
}

func Open(dbPath string) (*SQLiteBuffer, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open sqlite %s: %w", dbPath, err)
	}
	// Serialize SQLite access on a single connection so WAL writes never hit SQLITE_BUSY.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	pragmas := []string{
		"PRAGMA journal_mode=WAL;",
		"PRAGMA synchronous=NORMAL;",
		"PRAGMA busy_timeout=5000;",
		"PRAGMA temp_store=MEMORY;",
	}
	for _, p := range pragmas {
		if _, err := db.Exec(p); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("exec %s: %w", p, err)
		}
	}

	schema := `
	CREATE TABLE IF NOT EXISTS pending_samples (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		ts_unix_ns INTEGER NOT NULL,
		target_id  TEXT    NOT NULL,
		rtt_us     INTEGER,
		jitter_us  INTEGER NOT NULL DEFAULT 0,
		is_loss    INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_pending_samples_ts ON pending_samples(ts_unix_ns);

	CREATE TABLE IF NOT EXISTS pending_mtr (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		created_ns INTEGER NOT NULL,
		payload    TEXT    NOT NULL
	);
	`
	if _, err := db.Exec(schema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("init sqlite schema: %w", err)
	}

	return &SQLiteBuffer{db: db, dbPath: dbPath}, nil
}

func (b *SQLiteBuffer) Close() error {
	return b.db.Close()
}

func (b *SQLiteBuffer) EnqueueSamples(ctx context.Context, samples []protocol.SampleRecord) error {
	if len(samples) == 0 {
		return nil
	}
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	stmt, err := tx.PrepareContext(ctx, `
		INSERT INTO pending_samples (ts_unix_ns, target_id, rtt_us, jitter_us, is_loss)
		VALUES (?, ?, ?, ?, ?)
	`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, s := range samples {
		var rtt any
		if s.RTTUs != nil {
			rtt = int64(*s.RTTUs)
		}
		loss := 0
		if s.IsLoss {
			loss = 1
		}
		if _, err := stmt.ExecContext(ctx, s.TimestampNs, s.TargetID, rtt, int64(s.JitterUs), loss); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (b *SQLiteBuffer) PeekSamples(ctx context.Context, limit int) (int64, []protocol.SampleRecord, error) {
	if limit <= 0 {
		limit = 500
	}
	rows, err := b.db.QueryContext(ctx, `
		SELECT id, ts_unix_ns, target_id, rtt_us, jitter_us, is_loss
		FROM pending_samples
		ORDER BY id ASC
		LIMIT ?
	`, limit)
	if err != nil {
		return 0, nil, err
	}
	defer rows.Close()

	var maxID int64
	out := make([]protocol.SampleRecord, 0)
	for rows.Next() {
		var id, tsNs, jitter int64
		var targetID string
		var rttNull sql.NullInt64
		var lossInt int
		if err := rows.Scan(&id, &tsNs, &targetID, &rttNull, &jitter, &lossInt); err != nil {
			return 0, nil, err
		}
		var rttPtr *int32
		if rttNull.Valid {
			v := int32(rttNull.Int64)
			rttPtr = &v
		}
		out = append(out, protocol.SampleRecord{
			TimestampNs: tsNs,
			TargetID:    targetID,
			RTTUs:       rttPtr,
			JitterUs:    int32(jitter),
			IsLoss:      lossInt == 1,
		})
		if id > maxID {
			maxID = id
		}
	}
	return maxID, out, rows.Err()
}

func (b *SQLiteBuffer) AckSamplesUpTo(ctx context.Context, maxID int64) error {
	if maxID <= 0 {
		return nil
	}
	_, err := b.db.ExecContext(ctx, `DELETE FROM pending_samples WHERE id <= ?`, maxID)
	return err
}

func (b *SQLiteBuffer) CountSamples(ctx context.Context) (int64, error) {
	var cnt int64
	err := b.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM pending_samples`).Scan(&cnt)
	return cnt, err
}

func (b *SQLiteBuffer) EnqueueMTR(ctx context.Context, p protocol.MTRResultPayload) error {
	raw, err := json.Marshal(p)
	if err != nil {
		return err
	}
	_, err = b.db.ExecContext(ctx, `INSERT INTO pending_mtr (created_ns, payload) VALUES (?, ?)`, p.CapturedAtNs, string(raw))
	return err
}

func (b *SQLiteBuffer) PeekMTR(ctx context.Context, limit int) ([]QueuedMTR, error) {
	if limit <= 0 {
		limit = 20
	}
	rows, err := b.db.QueryContext(ctx, `SELECT id, payload FROM pending_mtr ORDER BY id ASC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []QueuedMTR
	for rows.Next() {
		var id int64
		var raw string
		if err := rows.Scan(&id, &raw); err != nil {
			return nil, err
		}
		var p protocol.MTRResultPayload
		if err := json.Unmarshal([]byte(raw), &p); err != nil {
			continue
		}
		out = append(out, QueuedMTR{ID: id, Payload: p})
	}
	return out, rows.Err()
}

func (b *SQLiteBuffer) AckMTR(ctx context.Context, id int64) error {
	_, err := b.db.ExecContext(ctx, `DELETE FROM pending_mtr WHERE id = ?`, id)
	return err
}

// EnforceRetention trims samples older than maxHours and keeps total DB file size within maxMB.
func (b *SQLiteBuffer) EnforceRetention(ctx context.Context, maxHours int, maxMB int, now time.Time) error {
	if maxHours > 0 {
		cutoffNs := now.Add(-time.Duration(maxHours) * time.Hour).UnixNano()
		if _, err := b.db.ExecContext(ctx, `DELETE FROM pending_samples WHERE ts_unix_ns < ?`, cutoffNs); err != nil {
			return err
		}
		if _, err := b.db.ExecContext(ctx, `DELETE FROM pending_mtr WHERE created_ns < ?`, cutoffNs); err != nil {
			return err
		}
	}

	if maxMB > 0 {
		limitBytes := int64(maxMB) * 1024 * 1024
		if info, err := os.Stat(b.dbPath); err == nil && info.Size() > limitBytes {
			// Drop oldest 10% of rows to keep ring-buffer bounded
			_, _ = b.db.ExecContext(ctx, `
				DELETE FROM pending_samples
				WHERE id IN (
					SELECT id FROM pending_samples ORDER BY id ASC LIMIT (
						SELECT MAX(1, COUNT(*) / 10) FROM pending_samples
					)
				)
			`)
		}
	}

	_, _ = b.db.ExecContext(ctx, `PRAGMA wal_checkpoint(PASSIVE);`)
	return nil
}
