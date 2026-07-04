export function uploadedKnowledgeFileNameKey(fileName?: string | null): string | null {
  const normalized = String(fileName ?? "").trim();
  return normalized ? normalized.toLowerCase() : null;
}

export function findDuplicateKnowledgeUploadName(files: Array<{ originalname?: string | null }>): string | null {
  const seen = new Set<string>();
  for (const file of files) {
    const key = uploadedKnowledgeFileNameKey(file.originalname);
    if (!key) continue;
    if (seen.has(key)) return String(file.originalname ?? "").trim() || key;
    seen.add(key);
  }
  return null;
}
