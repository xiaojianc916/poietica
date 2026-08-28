use crate::error::InvariantViolation;
use crate::event::EventEnvelope;
use crate::projection::ThreadView;

/// 落盘前的守卫：seq 必须单调，终局之后不许再来事件。
pub fn check_append(view: &ThreadView, envelope: &EventEnvelope) -> Result<(), InvariantViolation> {
    if envelope.seq.value() <= view.last_seq.value() {
        return Err(InvariantViolation::SeqNotMonotonic {
            thread: view.thread.clone(),
            seq: envelope.seq.value(),
            previous: view.last_seq.value(),
        });
    }

    let Some(turn) = envelope.event.turn() else {
        return Ok(());
    };

    if view
        .turns
        .get(turn)
        .is_some_and(|existing| existing.state.is_finished())
    {
        return Err(InvariantViolation::EventAfterFinish { turn: turn.clone() });
    }

    Ok(())
}
