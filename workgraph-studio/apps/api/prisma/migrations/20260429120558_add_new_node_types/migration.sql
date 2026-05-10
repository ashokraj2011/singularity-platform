-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NodeType" ADD VALUE 'SIGNAL_EMIT';
ALTER TYPE "NodeType" ADD VALUE 'PARALLEL_FORK';
ALTER TYPE "NodeType" ADD VALUE 'PARALLEL_JOIN';
ALTER TYPE "NodeType" ADD VALUE 'SET_CONTEXT';
ALTER TYPE "NodeType" ADD VALUE 'ERROR_CATCH';
