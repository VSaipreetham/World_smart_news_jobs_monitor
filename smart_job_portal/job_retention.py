"""Conservative listing cleanup without changing either portal's database schema."""

import datetime


def build_prune_statement(columns):
    """Delete only expired, untouched listings using reflected allowlisted fields."""
    columns = set(columns)
    if not {"id", "status", "notes"}.issubset(columns):
        return None
    date_columns = [name for name in (
        "last_seen_at", "refreshed_at", "first_seen_at", "created_at", "posted_date"
    ) if name in columns]
    if not date_columns:
        return None
    dates = [f"CAST({name} AS TEXT)" for name in date_columns]
    timestamp = dates[0] if len(dates) == 1 else f"COALESCE({', '.join(dates)})"
    day = f"SUBSTR({timestamp}, 1, 10)"
    conditions = [
        "LOWER(CAST(status AS TEXT)) IN ('new', 'open')",
        "TRIM(COALESCE(notes, '')) = ''",
        f"LENGTH({day}) = 10",
        f"SUBSTR({day}, 5, 1) = '-'",
        f"SUBSTR({day}, 8, 1) = '-'",
        f"SUBSTR({day}, 1, 4) BETWEEN '0001' AND '9999'",
        f"SUBSTR({day}, 6, 2) BETWEEN '01' AND '12'",
        f"SUBSTR({day}, 9, 2) BETWEEN '01' AND '31'",
        f"{day} < :cutoff",
    ]
    for name in ("applied_at", "follow_up_at", "archived_at"):
        if name in columns:
            conditions.append(f"{name} IS NULL")
    return "DELETE FROM jobs WHERE " + " AND ".join(conditions)


def retention_cutoff(days=30, now=None):
    """Retain at least the requested number of complete UTC days."""
    days = int(days)
    if days < 1:
        raise ValueError("JOB_RETENTION_DAYS must be at least 1")
    now = now or datetime.datetime.now(datetime.timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=datetime.timezone.utc)
    return (now.astimezone(datetime.timezone.utc) - datetime.timedelta(days=days)).date().isoformat()
