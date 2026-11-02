import { Bar, HeroSkeleton } from "../../components/Skeleton";

export default function Loading() {
  return (
    <>
      <HeroSkeleton />
      <Bar className="h-64 w-full rounded-xl mb-6" />
      <Bar className="h-40 w-full rounded-xl mb-6" />
      <Bar className="h-52 w-full rounded-xl" />
    </>
  );
}
