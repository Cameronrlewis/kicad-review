// [name, url hash, body of an async function that returns true when the check passes]
export const CHECKS = [
  ["loads sample", "", `return REVIEW_DATA.version === 1 && document.querySelector("#nav") !== null;`],
];
