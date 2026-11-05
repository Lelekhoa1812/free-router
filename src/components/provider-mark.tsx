const PROVIDER_LOGOS = {
  google: { src: "/brand/providers/google-ai-studio.png", width: 96, height: 96 },
  nvidia: { src: "/brand/providers/nvidia.svg", width: 164, height: 30 },
  openrouter: { src: "/brand/providers/openrouter.svg", width: 1024, height: 730 },
  matilda: { src: "/brand/providers/matilda.svg", width: 118, height: 118 },
  zenmux: { src: "/brand/providers/zenmux.svg", width: 160, height: 160 },
  orcarouter: { src: "/brand/providers/orcarouter.png", width: 180, height: 180 },
  mistral: { src: "/brand/providers/mistral.svg", width: 48, height: 48 },
} as const;

type ProviderId = keyof typeof PROVIDER_LOGOS;

function isProviderId(provider: string): provider is ProviderId {
  return Object.hasOwn(PROVIDER_LOGOS, provider);
}

export function ProviderMark({ provider }: { provider: string }) {
  const knownProvider = isProviderId(provider);
  const logo = knownProvider ? PROVIDER_LOGOS[provider] : undefined;

  // Provider names are rendered as adjacent text. Keep this visual mark decorative,
  // and use intrinsic dimensions so the small local asset does not cause layout shift.
  if (!logo) {
    const fallback = provider.trim().slice(0, 1).toUpperCase() || "?";
    return <span className="provider-icon unknown" aria-hidden="true">{fallback}</span>;
  }

  return (
    <span className={`provider-icon ${provider}`} aria-hidden="true">
      <img src={logo.src} width={logo.width} height={logo.height} alt="" decoding="async" />
    </span>
  );
}
