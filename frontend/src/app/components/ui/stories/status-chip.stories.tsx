import { StatusChip } from "@/app/components/ui/status-chip";

const meta = { title: "UI / StatusChip" };
export default meta;

/** Agent states first, then the task axis a person moves a card through. */
export const AllStates = () => (
    <div className="flex flex-wrap gap-2">
        <StatusChip status="rodando" label="Lendo o contrato…" />
        <StatusChip status="pronto" />
        <StatusChip status="em_andamento" />
        <StatusChip status="bloqueado" />
        <StatusChip status="aguardando" label="Aguardando o solicitante" />
        <StatusChip status="concluido" />
        <StatusChip status="a_fazer" />
        <StatusChip status="erro" />
    </div>
);
