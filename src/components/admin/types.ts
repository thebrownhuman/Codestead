export interface StatusCount {
  readonly status: string;
  readonly count: number;
}

export interface SafeCredentialSummary {
  readonly id: string;
  readonly ownerPublicId: string;
  readonly ownerName: string;
  readonly provider: string;
  readonly lastFour: string;
  readonly status: string;
  readonly preferred: boolean;
  readonly lastValidatedAt: string | null;
  readonly lastUsedAt: string | null;
  readonly failureCode: string | null;
}

export interface LearnerSummary {
  readonly publicId: string;
  readonly name: string;
  readonly email: string;
  readonly status: string;
  readonly level: string;
  readonly onboardingComplete: boolean;
  readonly selectedTracks: readonly string[];
  readonly lastMeaningfulActivityAt: string | null;
  readonly masteryAverage: number;
  readonly masteredSkills: number;
  readonly attempts: number;
  readonly passRate: number;
  readonly sessions: number;
  readonly sessionMinutes: number;
}

export interface AdminDashboardData {
  readonly generatedAt: string;
  readonly summary: {
    readonly learners: number;
    readonly activeLearners: number;
    readonly activeLast7Days: number;
    readonly pendingAccessRequests: number;
    readonly openAppeals: number;
    readonly runnerBacklog: number;
  };
  readonly learners: readonly LearnerSummary[];
  readonly learning: {
    readonly masteryRecords: number;
    readonly averageMastery: number;
    readonly masteredSkills: number;
    readonly reviewDue: number;
    readonly attempts: number;
    readonly passedAttempts: number;
    readonly passRate: number;
    readonly activeSessions: number;
    readonly sessionMinutes: number;
    readonly chatThreads: number;
    readonly chatMessages: number;
    readonly projects: number;
  };
  readonly providers: {
    readonly credentials: readonly SafeCredentialSummary[];
    readonly credentialStatusCounts: readonly StatusCount[];
    readonly policies: readonly {
      readonly provider: string;
      readonly operation: string;
      readonly model: string;
      readonly priority: number;
      readonly enabled: boolean;
      readonly timeoutMs: number;
    }[];
  };
  readonly content: {
    readonly authored: {
      readonly courses: number;
      readonly modules: number;
      readonly skills: number;
      readonly covered: number;
      readonly partial: number;
      readonly planned: number;
      readonly statuses: readonly StatusCount[];
    };
    readonly publications: readonly {
      readonly courseSlug: string;
      readonly title: string;
      readonly version: string;
      readonly stage: string;
      readonly modules: number;
      readonly lessons: number;
      readonly publishableLessons: number;
      readonly blocks: number;
      readonly activities: number;
      readonly coveragePercent: number;
      readonly publishedAt: string | null;
      readonly updatedAt: string;
    }[];
  };
  readonly operations: {
    readonly runner: {
      readonly statuses: readonly StatusCount[];
      readonly oldestQueuedAt: string | null;
      readonly recentFailures: readonly {
        readonly id: string;
        readonly status: string;
        readonly queuedAt: string;
        readonly completedAt: string | null;
      }[];
    };
    readonly backgroundJobs: {
      readonly statuses: readonly StatusCount[];
      readonly recentFailures: readonly {
        readonly id: string;
        readonly type: string;
        readonly status: string;
        readonly errorCode: string | null;
        readonly createdAt: string;
      }[];
    };
    readonly storage: {
      readonly objects: number;
      readonly bytes: number;
      readonly pendingScans: number;
      readonly quotaBytes: number | null;
      readonly quotaPercent: number | null;
      readonly ledgerBytes30Days: number;
    };
    readonly email: {
      readonly statuses: readonly StatusCount[];
      readonly oldestPendingAt: string | null;
      readonly recentFailures: readonly {
        readonly id: string;
        readonly template: string;
        readonly errorCode: string | null;
        readonly attemptCount: number;
        readonly updatedAt: string;
      }[];
    };
    readonly backup: {
      readonly recorded: boolean;
      readonly status: string;
      readonly type: string | null;
      readonly createdAt: string | null;
      readonly completedAt: string | null;
      readonly ageSeconds: number | null;
      readonly errorCode: string | null;
    };
  };
  readonly appeals: readonly {
    readonly id: string;
    readonly learnerPublicId: string;
    readonly learnerName: string;
    readonly target: "attempt" | "project_review" | "unspecified";
    readonly status: string;
    readonly createdAt: string;
    readonly decidedAt: string | null;
  }[];
  readonly audit: readonly {
    readonly id: string;
    readonly actorName: string;
    readonly action: string;
    readonly resourceType: string;
    readonly resourceId: string | null;
    readonly outcome: string;
    readonly occurredAt: string;
  }[];
}

export interface LearnerDetailData {
  readonly generatedAt: string;
  readonly learner: {
    readonly publicId: string;
    readonly name: string;
    readonly email: string;
    readonly status: string;
    readonly emailVerified: boolean;
    readonly mfaEnabled: boolean;
    readonly level: string;
    readonly preferredSessionMinutes: number | null;
    readonly weeklyGoalMinutes: number | null;
    readonly selectedTracks: readonly string[];
    readonly learningGoals: readonly string[];
    readonly onboardingCompletedAt: string | null;
    readonly lastMeaningfulActivityAt: string | null;
    readonly createdAt: string;
  };
  readonly enrollments: readonly {
    readonly id: string;
    readonly course: string;
    readonly version: string;
    readonly status: string;
    readonly implementationLanguage: string | null;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  }[];
  readonly mastery: {
    readonly total: number;
    readonly averageScore: number;
    readonly averageConfidence: number;
    readonly reviewDue: number;
    readonly statuses: readonly StatusCount[];
    readonly recent: readonly {
      readonly concept: string;
      readonly languageContext: string;
      readonly status: string;
      readonly score: number;
      readonly confidence: number;
      readonly lastEvidenceAt: string | null;
      readonly nextReviewAt: string | null;
    }[];
  };
  readonly attempts: {
    readonly total: number;
    readonly passed: number;
    readonly passRate: number;
    readonly averageScore: number;
    readonly statuses: readonly StatusCount[];
    readonly recent: readonly {
      readonly id: string;
      readonly kind: string;
      readonly status: string;
      readonly score: number | null;
      readonly passed: boolean | null;
      readonly masteryAwarded: boolean;
      readonly infrastructureFailure: boolean;
      readonly corrected: boolean;
      readonly createdAt: string;
    }[];
  };
  readonly sessions: {
    readonly total: number;
    readonly active: number;
    readonly plannedMinutes: number;
    readonly completedMinutes: number;
    readonly recent: readonly {
      readonly id: string;
      readonly goal: string;
      readonly status: string;
      readonly plannedMinutes: number;
      readonly startedAt: string;
      readonly lastActivityAt: string;
      readonly endedAt: string | null;
    }[];
  };
  readonly chats: {
    readonly threads: number;
    readonly messages: number;
    readonly recent: readonly {
      readonly id: string;
      readonly status: string;
      readonly messages: number;
      readonly updatedAt: string;
    }[];
  };
  readonly projects: {
    readonly total: number;
    readonly recent: readonly {
      readonly id: string;
      readonly title: string;
      readonly status: string;
      readonly visibility: string;
      readonly reviews: number;
      readonly updatedAt: string;
    }[];
  };
  readonly credentials: readonly SafeCredentialSummary[];
  readonly operations: {
    readonly activeAuthSessions: number;
    readonly lastSessionSeenAt: string | null;
    readonly storageObjects: number;
    readonly storageBytes: number;
    readonly pendingScans: number;
    readonly quotaBytes: number | null;
    readonly quotaPercent: number | null;
    readonly quotaRowVersion: number;
    readonly emailStatuses: readonly StatusCount[];
  };
  readonly appeals: readonly {
    readonly id: string;
    readonly target: "attempt" | "project_review" | "unspecified";
    readonly status: string;
    readonly createdAt: string;
    readonly decidedAt: string | null;
  }[];
}

export interface AccessRequestItem {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly reason: string | null;
  readonly status: string;
  readonly adultConfirmedAt: string | null;
  readonly emailVerifiedAt: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
}

export interface AccessRequestQueueData {
  readonly generatedAt: string;
  readonly pending: readonly AccessRequestItem[];
  readonly recent: readonly AccessRequestItem[];
  readonly statusCounts: readonly StatusCount[];
}
