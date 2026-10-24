/** High-confidence credential literals. Findings contain positions, never values. */
export function findSecretLiterals(text) {
  const rules = [
    ['github-token', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
    ['api-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{30,}/g],
    ['aws-key', /\bAKIA[0-9A-Z]{16}\b/g],
    ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
    ['private-key', /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{60,}/g],
  ];
  const findings=[];
  for(const [rule,pattern] of rules) for(const match of text.matchAll(pattern)) {
    findings.push({rule,line:text.slice(0,match.index).split('\n').length});
  }
  return findings;
}
