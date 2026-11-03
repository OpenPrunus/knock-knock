<?php

declare(strict_types=1);

namespace Knock\Tests\Engine;

use Knock\Engine\Game;
use Knock\Engine\Layout;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** Le moteur PHP rejoue les parties enregistrées par le moteur JavaScript : même grille, mêmes événements, même état final. */
final class FixturesTest extends TestCase
{
    /** @return iterable<string, array{array<string, mixed>}> */
    public static function games(): iterable
    {
        $data = json_decode((string) file_get_contents(__DIR__ . '/../../fixtures/engine-vectors.json'), true, flags: JSON_THROW_ON_ERROR);
        foreach ($data['games'] as $i => $game) {
            yield "partie $i (graine {$game['config']['seed']})" => [$game];
        }
    }

    /** @param array<string, mixed> $game */
    #[DataProvider('games')]
    public function testThePhpEngineReplaysTheJavaScriptGameExactly(array $game): void
    {
        $c = $game['config'];
        $layout = Layout::generate($c['cols'], $c['rows'], $c['bandits'], $c['detectives'], $c['seed']);
        $this->assertSame($game['layout']['items'], $layout->items, 'derrière les portes');
        $this->assertSame($game['layout']['skins'], $layout->skins, 'aspect des portes');
        $engine = new Game($layout, $c['players']);
        foreach ($game['actions'] as $i => $action) {
            $events = match ($action['a']) {
                'settle' => $engine->settle(),
                'skip' => $engine->skip(),
                default => $engine->open($action['c']),
            };
            $this->assertSame($game['events'][$i], $events, "action $i");
        }
        $final = $game['final'];
        $this->assertSame($final['state'], $engine->state);
        $this->assertSame($final['cash'], $engine->cash);
        $this->assertSame($final['shield'], $engine->shield);
        $this->assertSame($final['turn'], $engine->turn);
        $this->assertSame($final['over'], $engine->over);
        $this->assertSame($final['winner'], $engine->winner());
    }
}
