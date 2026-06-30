-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'MEMBER');

-- CreateEnum
CREATE TYPE "AssistantStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('QUEUED', 'UPLOADED', 'PARSING', 'EMBEDDING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('PDF', 'DOCX', 'MD', 'TXT');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT');

-- CreateTable
CREATE TABLE "tenant" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'OWNER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "system_prompt" TEXT,
    "model" TEXT NOT NULL DEFAULT 'claude-haiku-4-5',
    "refusal_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.35,
    "status" "AssistantStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assistant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "assistant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "source_type" "SourceType" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "page_count" INTEGER,
    "status" "DocumentStatus" NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chunk" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "assistant_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "token_count" INTEGER NOT NULL,
    "page" INTEGER,
    "section" TEXT,
    "char_start" INTEGER,
    "char_end" INTEGER,
    "content_hash" TEXT NOT NULL,
    "embedding" vector(1536),

    CONSTRAINT "chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "assistant_id" UUID NOT NULL,
    "end_user_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "citations" JSONB,
    "latency_ms" INTEGER,
    "tokens" INTEGER,
    "grounded" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_key" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "assistant_id" UUID NOT NULL,
    "key_hash" TEXT NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_key_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_user_tenant_id_email_key" ON "app_user"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "assistant_tenant_id_idx" ON "assistant"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "assistant_id_tenant_id_key" ON "assistant"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "document_tenant_id_assistant_id_idx" ON "document"("tenant_id", "assistant_id");

-- CreateIndex
CREATE INDEX "document_assistant_id_created_at_idx" ON "document"("assistant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "document_id_tenant_id_assistant_id_key" ON "document"("id", "tenant_id", "assistant_id");

-- CreateIndex
CREATE INDEX "chunk_tenant_id_assistant_id_idx" ON "chunk"("tenant_id", "assistant_id");

-- CreateIndex
CREATE INDEX "chunk_document_id_idx" ON "chunk"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "chunk_tenant_id_assistant_id_content_hash_key" ON "chunk"("tenant_id", "assistant_id", "content_hash");

-- CreateIndex
CREATE INDEX "conversation_tenant_id_assistant_id_idx" ON "conversation"("tenant_id", "assistant_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_id_tenant_id_key" ON "conversation"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "message_conversation_id_created_at_idx" ON "message"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "message_tenant_id_idx" ON "message"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_key_key_hash_key" ON "api_key"("key_hash");

-- CreateIndex
CREATE INDEX "api_key_tenant_id_assistant_id_idx" ON "api_key"("tenant_id", "assistant_id");

-- AddForeignKey
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant" ADD CONSTRAINT "assistant_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_assistant_id_tenant_id_fkey" FOREIGN KEY ("assistant_id", "tenant_id") REFERENCES "assistant"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunk" ADD CONSTRAINT "chunk_document_id_tenant_id_assistant_id_fkey" FOREIGN KEY ("document_id", "tenant_id", "assistant_id") REFERENCES "document"("id", "tenant_id", "assistant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_assistant_id_tenant_id_fkey" FOREIGN KEY ("assistant_id", "tenant_id") REFERENCES "assistant"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_tenant_id_fkey" FOREIGN KEY ("conversation_id", "tenant_id") REFERENCES "conversation"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_assistant_id_tenant_id_fkey" FOREIGN KEY ("assistant_id", "tenant_id") REFERENCES "assistant"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Constrain refusal_threshold to a valid 0..1 score.
ALTER TABLE "assistant" ADD CONSTRAINT "assistant_refusal_threshold_range"
  CHECK ("refusal_threshold" >= 0 AND "refusal_threshold" <= 1);
