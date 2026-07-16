import { useEffect, useRef, useState, type CSSProperties } from "react";

type AuthMode = "signin" | "signup";
type PaidPlan = "starter" | "pro" | "team";

interface CloudAuthExperienceProps {
  tr: boolean;
  email: string;
  password: string;
  busy: boolean;
  message: string;
  selectedPlan: PaidPlan | null;
  billingInterval: "monthly" | "annual";
  googleEnabled: boolean;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSignIn: () => void;
  onSignUp: () => void;
  onGoogle: () => void;
}

const BAYER_4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
];

function OneBitSignal() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pointer = { x: 0.72, y: 0.36 };
    let frame = 0;

    const move = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect();
      pointer.x = (event.clientX - bounds.left) / Math.max(1, bounds.width);
      pointer.y = (event.clientY - bounds.top) / Math.max(1, bounds.height);
    };

    const render = (time: number) => {
      const bounds = canvas.getBoundingClientRect();
      const width = Math.max(96, Math.floor(bounds.width / 5));
      const height = Math.max(72, Math.floor(bounds.height / 5));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const pixels = context.createImageData(width, height);
      const tick = reduceMotion ? 1.6 : time / 1_000;
      for (let y = 0; y < height; y++) {
        const ny = y / height;
        for (let x = 0; x < width; x++) {
          const nx = x / width;
          const dx = nx - pointer.x;
          const dy = ny - pointer.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          const orbit = Math.sin(distance * 44 - tick * 2.2);
          const horizon = Math.sin(nx * 9 + tick * 0.42) * 0.07 + 0.56;
          const terrain = Math.sin(nx * 21 - tick * 0.2) * 0.035 + Math.sin(nx * 47) * 0.012;
          const skySignal = orbit * 0.48 + Math.sin((nx + ny) * 12 + tick * 0.3) * 0.14;
          const groundSignal = Math.sin((nx * 1.5 + ny) * 32 + tick) * 0.36 + (ny - horizon) * 1.7;
          const signal = ny > horizon + terrain ? groundSignal : skySignal - ny * 0.34;
          const threshold = (BAYER_4[(x & 3) + ((y & 3) << 2)] / 15 - 0.5) * 0.88;
          const lit = signal > threshold;
          const offset = (y * width + x) * 4;
          const color = lit ? 239 : 5;
          pixels.data[offset] = color;
          pixels.data[offset + 1] = lit ? 238 : 5;
          pixels.data[offset + 2] = lit ? 229 : 5;
          pixels.data[offset + 3] = 255;
        }
      }
      context.putImageData(pixels, 0, 0);
      if (!reduceMotion) frame = window.requestAnimationFrame(render);
    };

    canvas.addEventListener("pointermove", move);
    render(0);
    return () => {
      canvas.removeEventListener("pointermove", move);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return <canvas ref={canvasRef} className="cloud-signal-canvas" aria-hidden="true" />;
}

export function CloudAuthExperience({
  tr,
  email,
  password,
  busy,
  message,
  selectedPlan,
  billingInterval,
  googleEnabled,
  onEmailChange,
  onPasswordChange,
  onSignIn,
  onSignUp,
  onGoogle,
}: CloudAuthExperienceProps) {
  const [mode, setMode] = useState<AuthMode>(selectedPlan ? "signup" : "signin");
  const ready = Boolean(email.trim()) && password.length >= 12;
  const submit = () => mode === "signin" ? onSignIn() : onSignUp();

  return (
    <section className="cloud-gate">
      <header className="cloud-gate__mast">
        <div className="cloud-gate__brand"><span>MNEMA</span><i />CLOUD ACCESS</div>
        <div className="cloud-gate__status"><b>●</b> SIGNAL ONLINE <span>RLS / TLS / MFA</span></div>
      </header>

      <div className="cloud-gate__hero">
        <div className="cloud-gate__visual">
          <OneBitSignal />
          <div className="cloud-gate__visual-grid" />
          <div className="cloud-gate__coordinate">41.0082° N<br />28.9784° E</div>
          <div className="cloud-gate__hero-copy">
            <span>MANAGED MEMORY NETWORK // 001</span>
            <h1>{tr ? "Bağlamın artık tek bir makineye bağlı değil." : "Your context is no longer tied to one machine."}</h1>
            <p>{tr
              ? "Projeler, kararlar ve agent hafızası; hesap tabanlı, tenant-izole bir çalışma alanında buluşur."
              : "Projects, decisions, and agent memory meet in an account-based, tenant-isolated workspace."}</p>
          </div>
          <div className="cloud-gate__capabilities" aria-label={tr ? "Cloud yetenekleri" : "Cloud capabilities"}>
            <span><b>01</b> PROJECT MAPS <i>LIVE</i></span>
            <span><b>02</b> MEMORY + DOCS <i>LIVE</i></span>
            <span><b>03</b> TENANT SEARCH <i>LIVE</i></span>
            <span><b>04</b> TEAM ROLES <i>MFA</i></span>
          </div>
        </div>

        <aside className="cloud-gate__auth" aria-label={tr ? "Cloud hesabı" : "Cloud account"}>
          <div className="cloud-gate__auth-head">
            <span>IDENTITY PORT // 02</span>
            <b>{mode === "signin" ? "RETURNING SIGNAL" : "NEW SIGNAL"}</b>
          </div>
          <div className="cloud-gate__tabs" role="tablist" aria-label={tr ? "Hesap işlemi" : "Account action"}>
            <button type="button" role="tab" aria-selected={mode === "signin"} onClick={() => setMode("signin")}>
              {tr ? "GİRİŞ" : "SIGN IN"}
            </button>
            <button type="button" role="tab" aria-selected={mode === "signup"} onClick={() => setMode("signup")}>
              {tr ? "KAYIT" : "CREATE ID"}
            </button>
          </div>

          {selectedPlan && (
            <div className="cloud-gate__plan-ticket">
              <span>{tr ? "SEÇİLEN ROTA" : "SELECTED ROUTE"}</span>
              <b>{selectedPlan.toUpperCase()} / {billingInterval.toUpperCase()}</b>
              <small>{tr ? "Hesaptan sonra plan seçimi korunur." : "Your route stays selected after authentication."}</small>
            </div>
          )}

          <button type="button" className="cloud-google" onClick={onGoogle} disabled={busy}>
            <span className="cloud-google__mark">G</span>
            <span>{tr ? "Google ile devam et" : "Continue with Google"}</span>
            <em>{googleEnabled ? "READY" : "SOON"}</em>
          </button>

          <div className="cloud-gate__divider"><span>{tr ? "VEYA E-POSTA" : "OR EMAIL"}</span></div>

          <form className="cloud-gate__form" onSubmit={(event) => { event.preventDefault(); submit(); }}>
            <label>
              <span>E-MAIL ADDRESS</span>
              <input
                type="email"
                value={email}
                autoComplete="email"
                placeholder="you@domain.com"
                onChange={(event) => onEmailChange(event.target.value)}
              />
            </label>
            <label>
              <span>PASSPHRASE <i>12+ CHAR</i></span>
              <input
                type="password"
                value={password}
                minLength={12}
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
                placeholder="••••••••••••"
                onChange={(event) => onPasswordChange(event.target.value)}
              />
            </label>
            <button className="cloud-gate__submit" type="submit" disabled={busy || !ready}>
              <span>{busy ? "SYNCING..." : mode === "signin" ? (tr ? "ÇALIŞMA ALANINA GİR" : "ENTER WORKSPACE") : (tr ? "CLOUD ID OLUŞTUR" : "CREATE CLOUD ID")}</span>
              <b>↗</b>
            </button>
          </form>

          <p className="cloud-gate__fineprint">{tr
            ? "Kayıt e-posta doğrulaması ister. Parola ve erişim tokenları Mnema sunucusunda tutulmaz; kimlik Supabase Auth tarafından yönetilir."
            : "Signup requires email verification. Passwords and access tokens are not stored by Mnema; identity is managed by Supabase Auth."}</p>
          {message && <div className="cloud-gate__message" role="status">{message}</div>}
        </aside>
      </div>

      <div className="cloud-clarity">
        <div className="cloud-clarity__intro">
          <span>WHY CLOUD // NOT JUST ANOTHER SERVER</span>
          <h2>{tr ? "Mnema Cloud neyi üstünden alıyor?" : "What does Mnema Cloud take off your plate?"}</h2>
          <p>{tr
            ? "Community ve Cloud aynı bilgi fikrini paylaşır. Fark; verinin nerede yaşadığı, kimlik/ekip sınırı ve operasyonu kimin yaptığıdır."
            : "Community and Cloud share the same knowledge idea. The difference is where data lives, the identity/team boundary, and who runs the operation."}</p>
        </div>
        <article>
          <span>SELF-HOST / COMMUNITY</span>
          <h3>{tr ? "Sunucu ve veri senin" : "Your server, your data"}</h3>
          <ul>
            <li>{tr ? "SQLite otoritesi ve donanım tamamen sende" : "SQLite authority and hardware are fully yours"}</li>
            <li>{tr ? "MCP ve REST’i doğrudan agentlarına açarsın" : "Expose MCP and REST directly to your agents"}</li>
            <li>{tr ? "TLS, yedek, güncelleme ve erişimi sen işletirsin" : "You operate TLS, backups, updates, and access"}</li>
          </ul>
        </article>
        <article className="cloud-clarity__managed">
          <span>MNEMA CLOUD / MANAGED</span>
          <h3>{tr ? "Hesap ve çalışma alanı hazır" : "Account and workspace included"}</h3>
          <ul>
            <li>{tr ? "Cihazdan bağımsız oturum ve tenant-izole Postgres" : "Device-independent login and tenant-isolated Postgres"}</li>
            <li>{tr ? "Rol, davet, MFA, kota ve veri dışa aktarma" : "Roles, invites, MFA, quotas, and data export"}</li>
            <li>{tr ? "Sunucu yönetmeden Cloud API ile ortak bağlam" : "Shared context through the Cloud API without server admin"}</li>
          </ul>
        </article>
        <div className="cloud-clarity__now">
          <span>PREVIEW // AVAILABLE NOW</span>
          <p>{tr
            ? "Hesap → izole workspace → proje haritası → memory/document API → tenant arama akışı bugün test edilebilir. Public host, Google OAuth ve Paddle checkout sonraki launch kapılarıdır."
            : "Account → isolated workspace → project map → memory/document API → tenant search is testable today. Public hosting, Google OAuth, and Paddle checkout are the next launch gates."}</p>
        </div>
      </div>
    </section>
  );
}

interface PixelCelebrationProps {
  plan: PaidPlan;
  tr: boolean;
  testMode: boolean;
  onClose: () => void;
}

export function PixelCelebration({ plan, tr, testMode, onClose }: PixelCelebrationProps) {
  const particles = Array.from({ length: 48 }, (_, index) => ({
    left: `${(index * 37) % 101}%`,
    delay: `${(index % 12) * 35}ms`,
    drift: `${((index * 17) % 140) - 70}px`,
    size: `${4 + (index % 4) * 3}px`,
  }));

  return (
    <div className="pixel-celebration" role="dialog" aria-modal="true" aria-live="assertive">
      <div className="pixel-celebration__rain" aria-hidden="true">
        {particles.map((particle, index) => (
          <i key={index} style={{
            left: particle.left,
            width: particle.size,
            height: particle.size,
            animationDelay: particle.delay,
            "--pixel-drift": particle.drift,
          } as CSSProperties} />
        ))}
      </div>
      <div className="pixel-celebration__card">
        <span>{testMode ? "STAGING ENTITLEMENT // NO CHARGE" : "SUBSCRIPTION CONFIRMED"}</span>
        <div className="pixel-celebration__glyph" aria-hidden="true">✦</div>
        <h2>{plan.toUpperCase()} {tr ? "SİNYALİ AÇILDI" : "SIGNAL UNLOCKED"}</h2>
        <p>{tr
          ? `${plan.toUpperCase()} limitleri çalışma alanına uygulandı. Artık akışı gerçek bir abone gibi test edebilirsin.`
          : `${plan.toUpperCase()} limits are applied to the workspace. You can now test the flow like a real subscriber.`}</p>
        <button type="button" onClick={onClose}>{tr ? "ÇALIŞMA ALANINA DEVAM ET" : "CONTINUE TO WORKSPACE"} <b>↗</b></button>
      </div>
    </div>
  );
}
