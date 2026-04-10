import { motion } from "framer-motion";

export function Modal(props: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (!props.open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 sm:items-center sm:p-4">
      <motion.div
        initial={{ opacity: 0, y: 10, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-lg sm:rounded-apple"
      >
        <div className="flex items-center justify-between">
          <div className="text-lg font-semibold text-gray-900">{props.title}</div>
          <button className="rounded-apple px-3 py-1 text-sm text-gray-600 hover:bg-gray-100" onClick={props.onClose}>
            Хаах
          </button>
        </div>
        <div className="mt-4 text-sm text-gray-700">{props.children}</div>
      </motion.div>
    </div>
  );
}
