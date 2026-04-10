export function Card(props: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-apple bg-white shadow-sm ${props.className ?? ""}`}>
      {props.children}
    </div>
  );
}