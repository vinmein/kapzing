import { PageContainer } from "@/components/ui/PageContainer";
import { AwsSitesManager } from "../../_components/aws-sites-manager";

export default async function AwsSitePage({
  params,
}: {
  params: Promise<{ account: string; name: string }>;
}) {
  const { account, name } = await params;
  return (
    <PageContainer>
      <AwsSitesManager key={`${account}/${name}`} detail={{ account, name }} />
    </PageContainer>
  );
}
