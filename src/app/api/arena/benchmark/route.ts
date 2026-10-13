import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * Per‑seat result format expected from the Flow Arena benchmark feed.
 * {
 *   roundId: string;
 *   seat: number;
 *   fighter: string;
 *   dataSpendUsdc: number;
 *   prizeUsdc: number;
 *   txHash: string;
 * }
 */
interface SeatResult {
  roundId: string;
  seat: number;
  fighter: string;
  dataSpendUsdc: number;
  prizeUsdc: number;
  txHash: string;
}

// File where we persist the benchmark results (simple JSON array).
const DATA_FILE = path.join(process.cwd(), 'data', 'arena-benchmark.json');

/** Ensure the data file exists and contains a JSON array. */
async function ensureDataFile() {
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify([]), 'utf8');
  }
}

/** POST /api/arena/benchmark */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const entries: SeatResult[] = Array.isArray(body) ? body : [body];

    for (const e of entries) {
      if (
        typeof e.roundId !== 'string' ||
        typeof e.seat !== 'number' ||
        typeof e.fighter !== 'string' ||
        typeof e.dataSpendUsdc !== 'number' ||
        typeof e.prizeUsdc !== 'number' ||
        typeof e.txHash !== 'string'
      ) {
        return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
      }
    }

    await ensureDataFile();
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const existing: SeatResult[] = JSON.parse(raw);
    const updated = [...existing, ...entries];
    await fs.writeFile(DATA_FILE, JSON.stringify(updated, null, 2), 'utf8');
    return NextResponse.json({ success: true, inserted: entries.length });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

/** GET /api/arena/benchmark */
export async function GET() {
  try {
    await ensureDataFile();
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    return NextResponse.json(data);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
