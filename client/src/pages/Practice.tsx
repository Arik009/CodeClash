import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { CodePanel, ProblemView, type Limits } from '../problem';
import { Alert, errorText, useLanguage } from '../ui';

interface PublicProblem { problemId: string; title: string; statement: string; samples: string; editorial: string; tags?: string[]; limits?: Limits }

export function Practice({ signedIn }: { signedIn: boolean }) {
  const { versionId = '' } = useParams();
  const [problem, setProblem] = useState<PublicProblem | null>(null);
  const [language, setLanguage] = useLanguage();
  const [error, setError] = useState('');

  useEffect(() => {
    api<PublicProblem>(`/api/problem-versions/${versionId}/public`).then(setProblem).catch((err) => setError(errorText(err)));
  }, [versionId]);

  async function submit(lang: string, code: string) {
    const result = await api<{ id: string }>('/api/practice/submissions', {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ problemVersionId: versionId, language: lang, code }),
    });
    return result.id;
  }

  async function run(lang: string, code: string) {
    return api<{ results: { verdict: string }[] }>('/api/run', {
      method: 'POST',
      body: JSON.stringify({ problemVersionId: versionId, language: lang, code }),
    });
  }

  return (
    <div className="page wide">
      <div className="crumbs"><Link to="/problemset">problemset</Link> / <span>{problem?.title ?? '…'}</span></div>
      {error ? <Alert>{error}</Alert> : null}
      {problem ? (
        <div className="workbench">
          <ProblemView problem={problem} language={language} />
          <CodePanel
            draftKey={`cc.practice.${problem.problemId}`}
            label={problem.title}
            submit={submit}
            run={signedIn ? run : undefined}
            onLanguage={setLanguage}
            blocked={signedIn ? undefined : 'sign in to run or submit'}
          />
        </div>
      ) : !error ? <div className="skeleton" style={{ height: '20rem' }} /> : null}
      {problem ? <p className="muted small" style={{ marginTop: '1rem' }}>Practice never changes standings. While a contest runs, practice waits for a free judge slot.</p> : null}
    </div>
  );
}
