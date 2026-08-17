import sqlite3
import os

db_path = os.path.join(os.environ.get("TEMP", ""), "poietica-check.sqlite3")
conn = sqlite3.connect(db_path)

cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
print("Tables:", [row[0] for row in cursor.fetchall()])

cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
print("Indexes:", [row[0] for row in cursor.fetchall()])

# Check threads table schema
cursor = conn.execute("PRAGMA table_info(threads)")
print("\nThreads columns:")
for row in cursor.fetchall():
    print(f"  {row}")

# Check if run_events exists
cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='run_events'")
print(f"\nrun_events exists: {cursor.fetchone() is not None}")

# Check thread count
cursor = conn.execute("SELECT count(*) FROM threads")
print(f"Thread count: {cursor.fetchone()[0]}")

conn.close()
