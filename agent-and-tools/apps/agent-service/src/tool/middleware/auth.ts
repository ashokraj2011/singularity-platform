// Keep the merged tool routes on the same authentication implementation as the
// agent routes. A second middleware here previously accepted locally signed
// JWTs before IAM, creating a security boundary split inside one process.
export { optionalAuth, requireAuth } from "../../middleware/auth";
