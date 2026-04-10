export function Button(props: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost";
  className?: string;
  type?: "button" | "submit";
}) {
  const v = props.variant ?? "primary";
  const base = "rounded-apple px-4 py-2 text-sm font-medium shadow-sm transition";
  const cls =
    v === "primary"
      ? "bg-[#0071E3] text-white hover:opacity-95"
      : "bg-white text-gray-800 border border-gray-200 hover:bg-gray-50";
  return (
    <button type={props.type ?? "button"} onClick={props.onClick} className={`${base} ${cls} ${props.className ?? ""}`}>
      {props.children}
    </button>
  );
}