type AuthShowcaseVariant = 'login' | 'register';

interface AuthShowcaseProps {
  variant: AuthShowcaseVariant;
  desktop?: boolean;
}

const showcaseCopy = {
  login: {
    eyebrow: 'Your calm interview co-pilot',
    title: 'Your next clear answer starts here.',
    description: 'Return to your role-aware workspace and stay focused on the conversation—not on finding the right words.',
  },
  register: {
    eyebrow: 'Prepare with purpose',
    title: 'Build confidence before the call begins.',
    description: 'Give Cueviq the context that matters, choose the right mode, and get concise guidance when the pressure is on.',
  },
};

const benefits = [
  'Role-aware guidance',
  'Three focused modes',
  'Windows and macOS',
];

export default function AuthShowcase({ variant, desktop = false }: AuthShowcaseProps) {
  const copy = showcaseCopy[variant];

  return (
    <aside className={`auth-showcase auth-showcase-${variant}`} aria-labelledby={`auth-showcase-title-${variant}`}>
      <div className="auth-showcase-copy">
        <span className="auth-showcase-eyebrow">
          <i aria-hidden="true" />
          {desktop ? 'Desktop connection ready' : copy.eyebrow}
        </span>
        <p id={`auth-showcase-title-${variant}`} className="auth-showcase-title">{copy.title}</p>
        <p>{desktop ? 'Sign in once in your browser, then continue securely in the desktop app.' : copy.description}</p>
      </div>

      {variant === 'login' ? (
        <div className="auth-showcase-preview" aria-hidden="true">
          <div className="auth-preview-topline">
            <span className="auth-preview-brand">
              <span className="auth-preview-mark"><img src="/favicon.svg" alt="" /></span>
              Cueviq cue
            </span>
            <span className="auth-preview-live"><i /> Ready</span>
          </div>
          <div className="auth-preview-question">
            <span>Interviewer</span>
            <p>“Tell me about a difficult technical trade-off you made.”</p>
          </div>
          <div className="auth-preview-answer">
            <span>Suggested structure</span>
            <strong>Decision → reasoning → impact</strong>
            <p>Lead with the constraint, explain the options you weighed, and close with a measurable result.</p>
          </div>
        </div>
      ) : (
        <div className="auth-showcase-preview auth-setup-preview" aria-hidden="true">
          <div className="auth-preview-topline">
            <span className="auth-preview-brand">
              <span className="auth-preview-mark"><img src="/favicon.svg" alt="" /></span>
              Your setup
            </span>
            <span className="auth-preview-live"><i /> 2 min</span>
          </div>
          <ol className="auth-setup-list">
            <li><span>1</span><div><strong>Create your account</strong><small>Start with ₹50 in wallet credit</small></div><i>✓</i></li>
            <li><span>2</span><div><strong>Add your context</strong><small>Resume, role, and experience</small></div><i>✓</i></li>
            <li><span>3</span><div><strong>Choose your mode</strong><small>Manual, Passive, or Screen</small></div><i>→</i></li>
          </ol>
        </div>
      )}

      <ul className="auth-showcase-benefits" aria-label="Cueviq benefits">
        {benefits.map((benefit) => (
          <li key={benefit}><span aria-hidden="true">✓</span>{benefit}</li>
        ))}
      </ul>
    </aside>
  );
}
