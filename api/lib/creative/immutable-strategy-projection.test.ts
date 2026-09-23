import {
  describe,
  expect,
  it,
} from "vitest";

import {
  projectCampaignFromImmutableStrategy,
} from "./immutable-strategy-projection";

describe(
  "immutable Strategy campaign projection",
  () => {
    it(
      "overrides mutable Strategy projections with immutable snapshot context without mutating the source row",
      () => {
        const campaign = {
          id: 30,
          coreMessage:
            "MUTABLE MESSAGE",
          personas: [
            {
              name:
                "Mutable persona",
            },
          ],
          workflowContext: {
            coreMessage:
              "MUTABLE WORKFLOW MESSAGE",
            valueProposition:
              "MUTABLE VALUE",
          },
        };

        const result =
          projectCampaignFromImmutableStrategy(
            campaign,
            {
              authority: {
                strategySnapshotId:
                  "strategy-snapshot-501",
                strategyVersion: 3,
                businessDnaSnapshotId:
                  "bdna-snapshot-9",
                strategyHashSha256:
                  "a".repeat(64),
                strategyRunId: 501,
                approvalRequestId: 77,
                creativeBriefFingerprint:
                  "brief-001",
              },
              snapshot: {},
              creativeContext: {
                coreMessage:
                  "IMMUTABLE MESSAGE",
                valueProposition:
                  "IMMUTABLE VALUE",
                positioning:
                  "IMMUTABLE POSITION",
                campaignTheme:
                  "IMMUTABLE THEME",
                personas: [
                  {
                    name:
                      "Immutable persona",
                  },
                ],
              },
            }
          );

        expect(
          result.coreMessage
        ).toBe(
          "IMMUTABLE MESSAGE"
        );

        expect(
          result.personas
        ).toEqual([
          {
            name:
              "Immutable persona",
          },
        ]);

        expect(
          result.workflowContext
        ).toMatchObject({
          coreMessage:
            "IMMUTABLE MESSAGE",
          valueProposition:
            "IMMUTABLE VALUE",
          positioning:
            "IMMUTABLE POSITION",
          campaignTheme:
            "IMMUTABLE THEME",
          strategySnapshotId:
            "strategy-snapshot-501",
          strategyVersion: 3,
        });

        expect(
          campaign.coreMessage
        ).toBe(
          "MUTABLE MESSAGE"
        );
      }
    );
  }
);
