// gjs -m tests/run.js
import System from 'system';
import {run} from './harness.js';
import './estimator.test.js';
import './pet.test.js';

System.exit(await run() ? 1 : 0);
