package db

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

func RunMigrations(ctx context.Context, pool *pgxpool.Pool) error {
	if _, err := pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)
	`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	entries, err := fs.ReadDir(migrationsFS, "migrations")
	if err != nil {
		return fmt.Errorf("read embedded migrations: %w", err)
	}

	var files []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".up.sql") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)

	for _, name := range files {
		var already bool
		err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = $1)`, name).Scan(&already)
		if err != nil {
			return fmt.Errorf("check migration %s: %w", name, err)
		}
		if already {
			continue
		}

		raw, err := fs.ReadFile(migrationsFS, "migrations/"+name)
		if err != nil {
			return fmt.Errorf("read migration %s: %w", name, err)
		}
		sqlText := string(raw)
		noTx := strings.Contains(sqlText, "-- migrate:no-tx")

		if noTx {
			stmts := splitSQLStatements(sqlText)
			conn, err := pool.Acquire(ctx)
			if err != nil {
				return fmt.Errorf("acquire conn for %s: %w", name, err)
			}
			for i, stmt := range stmts {
				if _, err := conn.Exec(ctx, stmt); err != nil {
					conn.Release()
					return fmt.Errorf("exec migration %s stmt %d: %w", name, i+1, err)
				}
			}
			if _, err := conn.Exec(ctx, `INSERT INTO schema_migrations (version) VALUES ($1)`, name); err != nil {
				conn.Release()
				return fmt.Errorf("record migration %s: %w", name, err)
			}
			conn.Release()
		} else {
			tx, err := pool.Begin(ctx)
			if err != nil {
				return fmt.Errorf("begin migration %s: %w", name, err)
			}
			if _, err := tx.Exec(ctx, sqlText); err != nil {
				_ = tx.Rollback(ctx)
				return fmt.Errorf("exec migration %s: %w", name, err)
			}
			if _, err := tx.Exec(ctx, `INSERT INTO schema_migrations (version) VALUES ($1)`, name); err != nil {
				_ = tx.Rollback(ctx)
				return fmt.Errorf("record migration %s: %w", name, err)
			}
			if err := tx.Commit(ctx); err != nil {
				return fmt.Errorf("commit migration %s: %w", name, err)
			}
		}
	}

	return nil
}

func splitSQLStatements(sqlText string) []string {
	var cleanedLines []string
	for _, line := range strings.Split(sqlText, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "--") {
			continue
		}
		cleanedLines = append(cleanedLines, line)
	}
	joined := strings.Join(cleanedLines, "\n")
	rawParts := strings.Split(joined, ";")
	var stmts []string
	for _, p := range rawParts {
		s := strings.TrimSpace(p)
		if s != "" {
			stmts = append(stmts, s)
		}
	}
	return stmts
}
