'use strict';
const {execFileSync} = require('node:child_process');

// The runner gives runtime credentials to node actions, but not to run: steps.
// Keep the pinned upload entrypoint and its input contract visible in review.yml.
if (!process.env.UPLOAD_SCRIPT) throw new Error('Missing digest-keyed asset upload script');
execFileSync('bash', ['-euo', 'pipefail', '-c', process.env.UPLOAD_SCRIPT], {stdio: 'inherit'});
