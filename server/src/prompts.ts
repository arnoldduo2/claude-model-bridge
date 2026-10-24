import type { RouteRequest, TaskKind } from './routes/types.js';

const TASK_INSTRUCTIONS: Record<TaskKind, string> = {
  explore: 'Explore the code below and explain how it works as it relates to the question.',
  plan: 'Produce a concrete implementation plan: ordered steps, the files each step touches, and the risks to watch for.',
  review: 'Review the code below. List concrete bugs, risks, and missing edge cases, most severe first.',
  ask: 'Answer the question using the code below.',
};

export function buildPrompt(req: RouteRequest, context?: string): string {
  const parts = [
    'You are a read-only code analysis assistant. You cannot run or modify anything; answer from the provided files only.',
    TASK_INSTRUCTIONS[req.task],
    'Rules: cite the source for every claim as file:line. If the files do not contain the answer, say so instead of guessing. Be concise: no preamble, no restating the question.',
    `Question:\n${req.question}`,
  ];
  if (context && context.trim()) parts.push(`Project files:\n${context}`);
  return parts.join('\n\n');
}
