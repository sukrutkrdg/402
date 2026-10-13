import React, { useEffect, useState } from 'react';

interface SeatResult {
  roundId: string;
  seat: number;
  fighter: string;
  dataSpendUsdc: number;
  prizeUsdc: number;
  txHash: string;
}

export default function BenchmarkPage() {
  const [results, setResults] = useState<SeatResult[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch('/api/arena/benchmark');
        if (res.ok) {
          const data: SeatResult[] = await res.json();
          setResults(data);
        }
      } catch (e) {
        console.error('Error fetching benchmark data', e);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  if (loading) return <p>Yükleniyor...</p>;

  return (
    <div style={{ padding: '2rem' }}>
      <h1>Arena Benchmark Sonuçları</h1>
      {results.length === 0 ? (
        <p>Henüz veri yok.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ border: '1px solid #ddd', padding: '8px' }}>Round ID</th>
              <th style={{ border: '1px solid #ddd', padding: '8px' }}>Seat</th>
              <th style={{ border: '1px solid #ddd', padding: '8px' }}>Fighter</th>
              <th style={{ border: '1px solid #ddd', padding: '8px' }}>Data Spend (USDC)</th>
              <th style={{ border: '1px solid #ddd', padding: '8px' }}>Prize (USDC)</th>
              <th style={{ border: '1px solid #ddd', padding: '8px' }}>Tx Hash</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, i) => (
              <tr key={i}>
                <td style={{ border: '1px solid #ddd', padding: '8px' }}>{r.roundId}</td>
                <td style={{ border: '1px solid #ddd', padding: '8px' }}>{r.seat}</td>
                <td style={{ border: '1px solid #ddd', padding: '8px' }}>{r.fighter}</td>
                <td style={{ border: '1px solid #ddd', padding: '8px' }}>{r.dataSpendUsdc}</td>
                <td style={{ border: '1px solid #ddd', padding: '8px' }}>{r.prizeUsdc}</td>
                <td style={{ border: '1px solid #ddd', padding: '8px' }}>{r.txHash}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
