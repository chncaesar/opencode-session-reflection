import { saveReportForRun } from "../../src/logging.js"

const [rootDir, runId, report] = process.argv.slice(2)
const saved = await saveReportForRun(rootDir, runId, () => report)
process.stdout.write(JSON.stringify(saved))
