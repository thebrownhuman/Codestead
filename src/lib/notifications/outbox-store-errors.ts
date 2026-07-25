import type { PostProviderExit } from "./provider-dispatch-contract";

export class ProviderBoundaryCommitUnknownError extends Error {
  constructor() {
    super("Provider boundary commit result is unknown.");
    this.name = "ProviderBoundaryCommitUnknownError";
  }
}

export class PostProviderPersistenceUnknownError extends Error {
  constructor(_exit: PostProviderExit) {
    super("Post-provider persistence result is unknown.");
    this.name = "PostProviderPersistenceUnknownError";
  }
}
