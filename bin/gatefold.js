#!/usr/bin/env node

import { main } from "../dist/src/cli.js";

await main(process.argv.slice(2));
