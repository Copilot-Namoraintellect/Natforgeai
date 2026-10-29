/**
 * Experimentation router — R7-D governed experiment surface.
 *
 * Experimentation is scoped-causal-evidence authority only: this router
 * manages experiment identity, design validation, R7-F governance binding,
 * deterministic assignment, lifecycle, authoritative evidence capture and
 * deterministic result calculation. It consumes R7-A/R7-B/R7-C/R7-F through
 * frozen seams (never merged), exposes narrow read-only downstream
 * projections for R7-C learning handback / R7-E optimisation input, and never
 * mutates upstream or downstream authority. No governance decision is made
 * here and no result is ever minted from model opinion.
 *
 * Clients reference ids and propose material only: every input is a strict
 * object and any client-supplied authority field is rejected at the boundary.
 */

import { z } from "zod";
import { createRouter, authedQuery } from "./middleware";
import { assertNoClientAuthorityFields } from "./lib/experimentation/experimentation-contract";
import {
  createExperiment,
  submitGovernance,
  activateExperiment,
  transitionExperiment,
  getAssignment,
  bindOutcomeEvidence,
  analyzeExperiment,
  getExperiment,
  listExperiments,
  getExperimentResult,
  getResultHandoffProjection,
  listResultHandoffProjections,
} from "./lib/experimentation/experimentation-service";

const exp1IdSchema = z.string().regex(/^exp1:[a-f0-9]{64}$/, "experimentId must be an exp1: id");
const lrn1IdSchema = z.string().regex(/^lrn1:[a-f0-9]{64}$/, "learningId must be an lrn1: id");

export const experimentationRouter = createRouter({
  create: authedQuery
    .input(
      z.strictObject({
        learningId: lrn1IdSchema,
        statement: z.string().min(1).max(1024),
        design: z.object({
          designType: z.enum(["A_B", "MULTI_ARM"]),
          dimension: z.enum([
            "channel",
            "audience",
            "creative",
            "budget",
            "schedule",
            "placement",
            "bidding",
            "pricing",
            "messaging",
          ]),
          controlDefinition: z.object({
            label: z.string().min(1).max(191),
            descriptor: z.record(z.string(), z.unknown()),
          }),
          treatmentDefinitions: z
            .array(
              z.object({
                label: z.string().min(1).max(191),
                descriptor: z.record(z.string(), z.unknown()),
              })
            )
            .min(1)
            .max(4),
          allocationPolicy: z.object({
            fractionsBps: z.array(z.number().int().positive()).min(2).max(5),
          }),
          primaryMetric: z.object({
            metric: z.enum([
              "CONVERSION_COUNT_PER_SUBJECT",
              "OUTCOME_COUNT_PER_SUBJECT",
              "REVENUE_MINOR_PER_SUBJECT",
              "POSITIVE_OUTCOME_RATE",
            ]),
            direction: z.enum(["HIGHER_IS_BETTER", "LOWER_IS_BETTER"]),
          }),
          secondaryMetrics: z
            .array(
              z.object({
                metric: z.enum([
                  "CONVERSION_COUNT_PER_SUBJECT",
                  "OUTCOME_COUNT_PER_SUBJECT",
                  "REVENUE_MINOR_PER_SUBJECT",
                  "POSITIVE_OUTCOME_RATE",
                ]),
                direction: z.enum(["HIGHER_IS_BETTER", "LOWER_IS_BETTER"]),
              })
            )
            .max(4)
            .optional(),
          guardrails: z
            .array(
              z.object({
                guardrail: z.enum([
                  "MINIMUM_SAMPLE_PER_ARM",
                  "BUDGET_CAP_MINOR",
                  "MAX_OBSERVATION_DURATION",
                  "STOP_ON_OUTCOME_REVERSAL",
                ]),
                params: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
              })
            )
            .max(8)
            .optional(),
          minimumSamplePerArm: z.number().int().min(1).max(1_000_000),
          durationDays: z.number().int().min(1).max(90),
        }),
        narrativeDraft: z.string().min(1).max(4096).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      assertNoClientAuthorityFields(input as unknown as Record<string, unknown>);
      return createExperiment(ctx.user.id, input);
    }),

  submitGovernance: authedQuery
    .input(z.strictObject({ experimentId: exp1IdSchema }))
    .mutation(async ({ ctx, input }) => {
      return submitGovernance(ctx.user.id, input);
    }),

  activate: authedQuery
    .input(z.strictObject({ experimentId: exp1IdSchema }))
    .mutation(async ({ ctx, input }) => {
      return activateExperiment(ctx.user.id, input);
    }),

  transition: authedQuery
    .input(
      z.strictObject({
        experimentId: exp1IdSchema,
        to: z.enum([
          "PAUSED",
          "STOPPED",
          "COMPLETED",
          "INVALIDATED",
          "CANCELLED",
        ]),
        reasonCode: z.string().min(1).max(191).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return transitionExperiment(ctx.user.id, input);
    }),

  assign: authedQuery
    .input(z.strictObject({ experimentId: exp1IdSchema, subjectRef: z.string().min(1).max(512) }))
    .mutation(async ({ ctx, input }) => {
      return getAssignment(ctx.user.id, input);
    }),

  bindOutcomeEvidence: authedQuery
    .input(
      z.strictObject({
        experimentId: exp1IdSchema,
        subjectRef: z.string().min(1).max(512),
        outcomeId: z.string().regex(/^out1:[a-f0-9]{64}$/),
        attributionId: z.string().regex(/^atr1:[a-f0-9]{64}$/).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return bindOutcomeEvidence(ctx.user.id, input);
    }),

  analyze: authedQuery
    .input(z.strictObject({ experimentId: exp1IdSchema }))
    .mutation(async ({ ctx, input }) => {
      return analyzeExperiment(ctx.user.id, input);
    }),

  get: authedQuery
    .input(z.strictObject({ experimentId: exp1IdSchema }))
    .query(async ({ ctx, input }) => {
      return getExperiment(ctx.user.id, input.experimentId);
    }),

  list: authedQuery
    .input(
      z.strictObject({
        businessId: z.number().int().positive().optional(),
        status: z
          .enum([
            "DRAFT",
            "GOVERNANCE_REQUIRED",
            "APPROVAL_REQUIRED",
            "READY",
            "ACTIVE",
            "PAUSED",
            "STOPPED",
            "COMPLETED",
            "INVALIDATED",
            "CANCELLED",
          ])
          .optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      return listExperiments(ctx.user.id, input);
    }),

  getResult: authedQuery
    .input(z.strictObject({ experimentId: exp1IdSchema }))
    .query(async ({ ctx, input }) => {
      return getExperimentResult(ctx.user.id, input);
    }),

  // ─── Read-only downstream projections (R7-C learning / R7-E consumption) ───

  getResultHandoffProjection: authedQuery
    .input(z.strictObject({ experimentId: exp1IdSchema }))
    .query(async ({ ctx, input }) => {
      return getResultHandoffProjection(ctx.user.id, input);
    }),

  listResultHandoffProjections: authedQuery
    .input(z.strictObject({ businessId: z.number().int().positive().optional() }))
    .query(async ({ ctx, input }) => {
      return listResultHandoffProjections(ctx.user.id, input);
    }),
});
