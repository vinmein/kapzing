import { PageContainer } from "@/components/ui/PageContainer";
import { AwsSitesManager } from "./_components/aws-sites-manager";

export default function AwsSitesPage() {
  return (
    <PageContainer>
      <div className="mb-6">
        <h1 className="text-2xl font-medium text-foreground/80">Create AWS site</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Create and manage S3 buckets, CloudFront distributions, and custom domains.
        </p>
      </div>
      <AwsSitesManager />
    </PageContainer>
  );
}
