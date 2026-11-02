import { Bar } from "../../../components/Skeleton";

export default function Loading() {
  return (
    <>
      <Bar className="h-3 w-32 mb-4" />
      <Bar className="h-7 w-56 mb-2" />
      <Bar className="h-3 w-24 mb-6" />

      <Bar className="h-20 w-full rounded-xl mb-6" />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Bar className="h-56 w-full rounded-xl" />
          <Bar className="h-72 w-full rounded-xl" />
        </div>
        <Bar className="h-48 w-full rounded-xl" />
      </div>
    </>
  );
}
