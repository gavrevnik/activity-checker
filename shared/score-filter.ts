export function isAiScoreInput(value: string) {
  return value === "" || (/^\d{1,2}$/.test(value) && Number(value) <= 10);
}

export function matchesAiScore(score: number | null, minimum: string) {
  return minimum === "" || (score !== null && score >= Number(minimum));
}
