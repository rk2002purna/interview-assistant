import type { ReactNode } from 'react';

type AuthMode = 'login' | 'register';

interface AuthExperienceProps {
  mode: AuthMode;
  eyebrow: string;
  title: string;
  subtitle: string;
  children: ReactNode;
}

const showcaseCopy = {
  login: {
    badge: 'Your private interview copilot',
    title: 'Stay in the conversation.',
    accent: 'We’ll surface what matters.',
    description: 'UpNod quietly turns live interview context into clear, structured guidance—so you can answer with confidence and stay fully present.',
    question: 'How would you scale this service reliably?',
    answer: 'Start with traffic patterns, isolate bottlenecks, then design each layer for graceful failure.',
    status: 'Response ready in 1.8s',
    benefits: ['Real-time guidance', 'Private by design', 'You stay in control'],
  },
  register: {
    badge: 'Build interview confidence',
    title: 'Start prepared.',
    accent: 'Get sharper every session.',
    description: 'Create your workspace and turn difficult questions into calm, structured conversations with support that adapts to your interview.',
    question: 'Tell me about a project you’re proud of.',
    answer: 'Frame the challenge, the decisions you owned, and the measurable outcome your work created.',
    status: 'Your first session is ready',
    benefits: ['₹50 welcome credit', 'No subscription required', 'Windows + macOS'],
  },
} as const;

export default function AuthExperience({ mode, eyebrow, title, subtitle, children }: AuthExperienceProps) {
  const copy = showcaseCopy[mode];

  return (
    <main className={`auth-experience auth-experience--${mode}`}>
      <div className="auth-ambient" aria-hidden="true">
        <span className="auth-orb auth-orb--one" />
        <span className="auth-orb auth-orb--two" />
        <span className="auth-orb auth-orb--three" />
        <span className="auth-grid-glow" />
      </div>

      <section className="auth-layout" aria-labelledby="auth-page-title">
        <div className="auth-form-column">
          <div className="auth-form-card">
            <div className="auth-mobile-signal" aria-hidden="true">
              <span className="auth-live-dot" />
              UpNod copilot is ready
              <span className="auth-mobile-wave"><i /><i /><i /><i /></span>
            </div>

            <span className="auth-form-eyebrow">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="M12 3l7 3v5c0 4.6-2.9 8.2-7 10-4.1-1.8-7-5.4-7-10V6l7-3Z" />
                <path d="m9.2 12 1.8 1.8 3.9-4" />
              </svg>
              {eyebrow}
            </span>
            <h1 id="auth-page-title" className="auth-form-title">{title}</h1>
            <p className="auth-form-subtitle">{subtitle}</p>

            {children}
          </div>

          <div className="auth-trust-note" aria-label="Security information">
            <span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <rect x="5" y="10" width="14" height="10" rx="3" />
                <path d="M8 10V7a4 4 0 0 1 8 0v3" />
              </svg>
              Encrypted access
            </span>
            <i aria-hidden="true" />
            <span>No data selling</span>
            <i aria-hidden="true" />
            <span>Built for privacy</span>
          </div>
        </div>

        <aside className="auth-story" aria-label="Why use UpNod">
          <div className="auth-story-copy">
            <span className="auth-story-badge">
              <span className="auth-live-dot" aria-hidden="true" />
              {copy.badge}
            </span>
            <h2 className="auth-story-title">
              {copy.title}
              <span>{copy.accent}</span>
            </h2>
            <p>{copy.description}</p>
            <ul className="auth-benefit-list">
              {copy.benefits.map((benefit) => (
                <li key={benefit}>
                  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <circle cx="10" cy="10" r="9" fill="currentColor" opacity=".14" />
                    <path d="m6.5 10 2.2 2.2 4.8-4.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {benefit}
                </li>
              ))}
            </ul>
          </div>

          <div className="auth-showcase" aria-hidden="true">
            <div className="auth-showcase-halo" />
            <div className="auth-demo-window">
              <div className="auth-demo-toolbar">
                <div className="auth-window-dots"><i /><i /><i /></div>
                <span>Live interview session</span>
                <div className="auth-session-live"><i /> Live</div>
              </div>

              <div className="auth-demo-body">
                <div className="auth-question-card">
                  <div className="auth-speaker-avatar">IN</div>
                  <div>
                    <span>Interviewer</span>
                    <p>{copy.question}</p>
                  </div>
                  <div className="auth-waveform"><i /><i /><i /><i /><i /><i /><i /></div>
                </div>

                <div className="auth-suggestion-card">
                  <div className="auth-suggestion-head">
                    <span>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                        <path d="m12 3 1.2 4.2L17 9l-3.8 1.8L12 15l-1.2-4.2L7 9l3.8-1.8L12 3Z" />
                        <path d="m18.5 14 .7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z" />
                      </svg>
                      Suggested structure
                    </span>
                    <small>UpNod AI</small>
                  </div>
                  <p>{copy.answer}</p>
                  <div className="auth-suggestion-points">
                    <span><i /> Clarify the goal</span>
                    <span><i /> Explain trade-offs</span>
                    <span><i /> Close with impact</span>
                  </div>
                </div>
              </div>

              <div className="auth-demo-footer">
                <span><i /> Context protected</span>
                <div className="auth-processing-line"><i /></div>
              </div>
            </div>

            <div className="auth-floating-chip auth-floating-chip--status">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M5 12.5 9 16l10-10" />
              </svg>
              {copy.status}
            </div>
            <div className="auth-floating-chip auth-floating-chip--privacy">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="5" y="10" width="14" height="10" rx="3" />
                <path d="M8 10V7a4 4 0 0 1 8 0v3" />
              </svg>
              Private session
            </div>
          </div>
        </aside>
      </section>
    </main>
  );
}
