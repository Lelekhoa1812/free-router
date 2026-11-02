const PROVIDER_LOGOS: Record<string, string> = {
  google: "/brand/providers/google-ai-studio.png",
  nvidia: "/brand/providers/nvidia.svg",
  openrouter: "/brand/providers/openrouter.svg",
};

export function ProviderMark({ provider }: { provider: string }) {
  const logo = PROVIDER_LOGOS[provider];

  if (!logo) return <span className={`provider-icon ${provider}`} aria-hidden="true">{provider.slice(0, 1).toUpperCase()}</span>;

  return (
    <span className={`provider-icon ${provider}`} aria-hidden="true">
      <img src={logo} alt="" />
    </span>
  );
}
