import { Save } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useBodyProfile,
  useBodyTrend,
  useDailyEnergyBalance,
  useRecordBodyMetric,
  useSetBodyProfile,
} from "@/lib/query";

import { shortDate } from "./workoutDates";
import { fmtKcal, num, parseOptionalInt, parseOptionalNumber, trimNum } from "./workoutFormat";

/**
 * 체성분 + 신체 프로필 + 에너지 수지.
 *
 * 에너지 수지는 **read-only 파생**이다 — 여기 숫자가 칼로리 목표를 자동으로 바꾸지 않는다
 * (파생 판단값 자동 설정 금지). 프로필이 비어 BMR을 못 내면 그 사실을 그대로 노출한다.
 */
export function BodySection({ today }: { today: string }) {
  const { data: trend } = useBodyTrend(30);
  const { data: profile } = useBodyProfile();
  const { data: energy } = useDailyEnergyBalance(today);
  const record = useRecordBodyMetric();

  const [weight, setWeight] = useState("");
  const [fat, setFat] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);

  const submitMetric = async () => {
    if (record.isPending) return;
    const weightKg = parseOptionalNumber(weight);
    const bodyFatPct = parseOptionalNumber(fat);
    if (weightKg == null && bodyFatPct == null) return;
    await record.mutateAsync({
      measuredOn: today,
      weightKg,
      bodyFatPct,
      skeletalMuscleKg: null,
      waistCm: null,
      note: null,
    });
    setWeight("");
    setFat("");
  };

  return (
    <section className="wo-section" aria-label="체성분과 에너지 수지">
      <h2 className="typo-label-lg wo-section-title">몸</h2>

      <div className="wo-body-grid">
        <div className="wo-card">
          <span className="typo-label-sm">최근 측정</span>
          {trend?.latest == null ? (
            <p className="typo-caption-sm wo-hint">측정 기록이 없습니다.</p>
          ) : (
            <>
              <div className="wo-card-value typo-title-sm">{trimNum(trend.latest.weightKg)}kg</div>
              <span className="typo-caption-sm">
                {shortDate(trend.latest.measuredOn)}
                {trend.latest.bodyFatPct != null &&
                  ` · 체지방 ${trimNum(trend.latest.bodyFatPct)}%`}
              </span>
              {trend.weightTrendKg != null && (
                <span className="typo-caption-sm wo-hint">
                  최근 7회 평균 {trimNum(trend.weightTrendKg)}kg
                </span>
              )}
            </>
          )}
          <div className="wo-inline-form">
            <Input
              inputMode="decimal"
              className="wo-composer-num"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              placeholder="kg"
              aria-label="체중"
            />
            <Input
              inputMode="decimal"
              className="wo-composer-num"
              value={fat}
              onChange={(e) => setFat(e.target.value)}
              placeholder="체지방%"
              aria-label="체지방률"
            />
            <Button
              variant="outline"
              size="sm"
              disabled={record.isPending}
              onClick={() => void submitMetric()}
            >
              <Save className="size-4" /> 오늘 기록
            </Button>
          </div>
        </div>

        <div className="wo-card">
          <span className="typo-label-sm">오늘 에너지 수지</span>
          {energy == null ? (
            <p className="typo-caption-sm wo-hint">계산 중…</p>
          ) : energy.balance.bmrAvailable ? (
            <>
              <div className="wo-card-value typo-title-sm">
                {num(energy.balance.balanceKcal) >= 0 ? "+" : "−"}
                {Math.abs(Math.round(num(energy.balance.balanceKcal)))}
                <span className="typo-caption-sm"> kcal</span>
              </div>
              <span className="typo-caption-sm">
                섭취 {fmtKcal(energy.balance.intakeKcal)} − 기초 {fmtKcal(energy.balance.bmrKcal)}
                {num(energy.balance.workoutKcal) > 0 &&
                  ` − 운동 ${fmtKcal(energy.balance.workoutKcal)}`}
              </span>
              <span className="typo-caption-sm wo-hint">
                표시용 파생값입니다 — 칼로리 목표는 식단에서 직접 정합니다.
              </span>
            </>
          ) : (
            <>
              <div className="wo-card-value typo-title-sm">—</div>
              <span className="typo-caption-sm wo-hint">
                기초대사량을 내려면 생년·키와 체중 측정이 필요합니다. 추정치를 대신 쓰지 않습니다.
              </span>
              <Button variant="outline" size="sm" onClick={() => setProfileOpen(true)}>
                프로필 입력
              </Button>
            </>
          )}
        </div>

        <div className="wo-card">
          <span className="typo-label-sm">신체 프로필</span>
          {profileOpen ? (
            <ProfileForm onDone={() => setProfileOpen(false)} />
          ) : (
            <>
              <span className="typo-caption-sm">
                {profile?.birthYear != null ? `${profile.birthYear}년생` : "생년 미입력"} ·{" "}
                {profile?.heightCm != null ? `${trimNum(profile.heightCm)}cm` : "키 미입력"} ·{" "}
                {profile?.sex ?? "성별 미입력"}
              </span>
              <span className="typo-caption-sm wo-hint">
                변하지 않는 값만 여기 둡니다 — 체중은 위 측정 기록으로.
              </span>
              <Button variant="ghost" size="sm" onClick={() => setProfileOpen(true)}>
                수정
              </Button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function ProfileForm({ onDone }: { onDone: () => void }) {
  const { data: profile } = useBodyProfile();
  const save = useSetBodyProfile();
  const [birthYear, setBirthYear] = useState(
    profile?.birthYear != null ? String(profile.birthYear) : "",
  );
  const [heightCm, setHeightCm] = useState(
    profile?.heightCm != null ? trimNum(profile.heightCm) : "",
  );
  const [sex, setSex] = useState(profile?.sex ?? "");

  return (
    <div className="wo-inline-form">
      <Input
        inputMode="numeric"
        className="wo-composer-num"
        value={birthYear}
        onChange={(e) => setBirthYear(e.target.value)}
        placeholder="1987"
        aria-label="출생 연도"
      />
      <Input
        inputMode="decimal"
        className="wo-composer-num"
        value={heightCm}
        onChange={(e) => setHeightCm(e.target.value)}
        placeholder="cm"
        aria-label="키"
      />
      <select
        className="wo-select typo-caption-sm"
        value={sex}
        aria-label="성별"
        onChange={(e) => setSex(e.target.value)}
      >
        <option value="">미지정</option>
        <option value="male">남성</option>
        <option value="female">여성</option>
        <option value="other">기타</option>
      </select>
      <Button
        variant="outline"
        size="sm"
        disabled={save.isPending}
        onClick={async () => {
          await save.mutateAsync({
            birthYear: parseOptionalInt(birthYear),
            heightCm: parseOptionalNumber(heightCm),
            sex: sex === "" ? null : sex,
          });
          onDone();
        }}
      >
        저장
      </Button>
      <Button variant="ghost" size="sm" onClick={onDone}>
        취소
      </Button>
    </div>
  );
}
