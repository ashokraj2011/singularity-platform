-- Local cache mirror of IAM capabilities
CREATE TABLE "capabilities_cache" (
    "id"       TEXT NOT NULL,
    "name"     TEXT NOT NULL,
    "type"     TEXT,
    "status"   TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "capabilities_cache_pkey" PRIMARY KEY ("id")
);
