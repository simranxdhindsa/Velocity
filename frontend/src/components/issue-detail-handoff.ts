// True while IssueDetailSkeleton is mounted. IssueDetailPanel reads it on its first
// render so it can skip the open animation when it takes over from the skeleton.
let skeletonActive = false
export const setSkeletonActive = (v: boolean) => { skeletonActive = v }
export const isSkeletonActive = () => skeletonActive
