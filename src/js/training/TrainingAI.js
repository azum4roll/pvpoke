// Load AI archetypes

var file = webRoot+"data/training/aiArchetypes.json?v=1";
var aiData = [];

$.getJSON( file, function( data ){
	aiData = data;
	console.log("AI data loaded ["+aiData.length+"]");
});

function TrainingAI(l, p, b){
	var level = parseInt(l);
	var player = p;
	var battle = b;
	var gm = GameMaster.getInstance();
	var teamPool = [];
	var partySize = 3;
	var props = aiData[l];
	var generateRosterCallback;
	var self = this;

	var currentStrategy; // The current employed strategy to determine behavior
	var previousStrategy; // Store the previous strategy
	var scenarios;

	var turnLastEvaluated = 0;

	if(level == 0){
		chargedMoveCount = 1;
	}

	// Generate a random roster of 6 given a cup and league

	this.generateRoster = function(size, callback){
		partySize = size;
		generateRosterCallback = callback;

		var league = battle.getCP();
		var cup = battle.getCup().name;

		if(! teamPool[league+""+cup]){
			gm.loadTeamData(league, cup, self.setTeamPool);
			return;
		}

		var pool = teamPool[league+""+cup];
		var slotBucket = [];
		var slots = [];

		// Put all the slots in bucket, multiple times for its weight value

		for(var i = 0; i < pool.length; i++){
			for(var n = 0; n < pool[i].weight; n++){
				slotBucket.push(pool[i].slot);
			}
		}

		// Draw 6 unique slots from the bucket

		for(var i = 0; i < 6; i++){
			var index = Math.floor(Math.random() * slotBucket.length);
			var slot = slotBucket[index];
			var synergies = pool.filter(obj => {
  				return obj.slot === slot
			})[0].synergies;
			slots.push(slot);

			// Add synergies to bucket to increase chances of picking them
			for(var n = 0; n < synergies.length; n++){
				if(slotBucket.indexOf(synergies[n]) > -1){
					slotBucket.push(synergies[n], synergies[n]);
				}
			}

			// Clear the selected value from the bucket
			var itemIndex = 0;
			while ((itemIndex = slotBucket.indexOf(slot, itemIndex)) > -1) {
			  slotBucket.splice(itemIndex, 1);
			}
		}

		// For each slot, pick a random Pokemon

		var roster = [];
		var selectedIds = []; // Array of Pokemon ID's to check to avoid duplicates

		for(var i = 0; i < slots.length; i++){
			// Grab the pool of Pokemon given the slot name
			var slotPool = pool.filter(obj => {
  				return obj.slot === slots[i]
			})[0].pokemon;
			var pokeBucket = [];

			for(var n = 0; n < slotPool.length; n++){
				var poke = slotPool[n];
				// Is this Pokemon valid to be added to the team?
				if((selectedIds.indexOf(poke.speciesId) === -1)&&(Math.abs(poke.difficulty - level) <= 1)){
					for(var j = 0; j < poke.weight; j++){
						pokeBucket.push(poke);
					}
				}
			}

			// Select a random poke from the bucket
			var index = Math.floor(Math.random() * pokeBucket.length);
			var poke = pokeBucket[index];

			var pokemon = new Pokemon(poke.speciesId, player.index, battle);
			pokemon.initialize(battle.getCP());

			// Select a random IV spread according to difficulty
			var ivCombos = pokemon.generateIVCombinations("overall", 1, props.ivComboRange);
			var rank = Math.floor(Math.random() * ivCombos.length);

			// If this Pokemon maxes under or near 1500, make sure it's close to 1500
			if(ivCombos[0].level >= 39){
				rank = Math.floor(Math.random() * 50 * (props.ivComboRange  / 4000));
			}
			var combo = ivCombos[rank];

			pokemon.setIV("atk", combo.ivs.atk);
			pokemon.setIV("def", combo.ivs.def);
			pokemon.setIV("hp", combo.ivs.hp);
			pokemon.setLevel(combo.level);

			pokemon.selectMove("fast", poke.fastMove);
			for(var n = 0; n < props.chargedMoveCount; n++){
				pokemon.selectMove("charged", poke.chargedMoves[n], n);
			}

			if(props.chargedMoveCount == 1){
				pokemon.selectMove("charged", "none", 1);
			}

			roster.push(pokemon);
			selectedIds.push(poke.speciesId);
		}

		player.setRoster(roster);
		generateRosterCallback(roster);
	}

	// With a set roster, produce a team of 3

	this.generateTeam = function(opponentRoster, previousResult, previousTeams, forcePickStrategy){
		var roster = player.getRoster();
		var team = [];

		// Reset all Pokemon involves

		for(var i = 0; i < opponentRoster.length; i++){
			opponentRoster[i].fullReset();
		}

		for(var i = 0; i < roster.length; i++){
			roster[i].fullReset();
		}

		// In Single 3v3 mode, use the Basic option most of the time depending on difficulty
		var basicWeight = 1;

		if(opponentRoster.length < 6){
			basicWeight = (8 * (4 - level));
		}

		// Choose a pick strategy
		var pickStrategyOptions = [];

		if(! previousResult){
			// If this is a fresh round, use these strategies
			pickStrategyOptions.push(new DecisionOption("BASIC", basicWeight));
			pickStrategyOptions.push(new DecisionOption("BEST", 6));
			pickStrategyOptions.push(new DecisionOption("COUNTER", 6));
			pickStrategyOptions.push(new DecisionOption("UNBALANCED", 3));
		} else{
			// If this is subsequent round, use these strategies
			var winStratWeight = 2;
			var loseStratWeight = 2;

			if(previousResult == "win"){
				loseStratWeight = 6;
			} else if(previousResult == "loss"){
				winStratWeight = 6;
			}

			pickStrategyOptions.push(new DecisionOption("SAME_TEAM", winStratWeight));
			pickStrategyOptions.push(new DecisionOption("SAME_TEAM_DIFFERENT_LEAD", winStratWeight));
			pickStrategyOptions.push(new DecisionOption("COUNTER_LAST_LEAD", loseStratWeight));
			pickStrategyOptions.push(new DecisionOption("COUNTER", loseStratWeight));
		}

		var pickStrategy = self.chooseOption(pickStrategyOptions).name;

		switch(pickStrategy){
			// Choose a random set of 3 from the roster
			case "BASIC":
				var startIndex = Math.floor(Math.random() * 4);
				for(var i = 0; i < 3; i++){
					team.push(roster[startIndex + i]);
				}
				break;

			// Choose a team that has the best average matchups against the opponent's roster
			case "BEST":
				var teamPerformance = self.calculateAverageRosterPerformance(roster, opponentRoster);

				// Lead with the best average Pokemon
				team.push(teamPerformance[0].pokemon);

				// Next, let's give it a bodyguard
				var scenarios = teamPerformance[0].scenarios;
				scenarios.sort((a,b) => (a.average > b.average) ? 1 : ((b.average > a.average) ? -1 : 0)); // Sort by worst to best

				var targets = [scenarios[0].opponent, scenarios[1].opponent];

				teamPerformance = self.calculateAverageRosterPerformance(roster, targets);

				// Add the best bodyguard that isn't the currently selected Pokemon
				for(var i = 0; i < teamPerformance.length; i++){
					if(team.indexOf(teamPerformance[i].pokemon) == -1){
						team.push(teamPerformance[i].pokemon);
						break;
					}
				}

				// Finally, let's round them out with a Pokemon that does best against their collective counters
				teamPerformance = self.calculateAverageRosterPerformance(opponentRoster, team);
				targets = [teamPerformance[0].pokemon, teamPerformance[1].pokemon];

				teamPerformance = self.calculateAverageRosterPerformance(roster, targets);
				// Add the best bodyguard that isn't the currently selected Pokemon
				for(var i = 0; i < teamPerformance.length; i++){
					if(team.indexOf(teamPerformance[i].pokemon) == -1){
						team.push(teamPerformance[i].pokemon);
						break;
					}
				}

				break;

			// Choose a team that counters the opponent's best Pokemon
			case "COUNTER":
				var teamPerformance = self.calculateAverageRosterPerformance(opponentRoster, roster);
				var scenarios = teamPerformance[0].scenarios;

				scenarios.sort((a,b) => (a.average > b.average) ? 1 : ((b.average > a.average) ? -1 : 0)); // Sort by worst to best

				// Lead with the best counter
				team.push(scenarios[0].opponent);

				// Next, let's give it a bodyguard
				var scenarios = self.runBulkScenarios("NO_BAIT", team[0], opponentRoster);
				scenarios.sort((a,b) => (a.average > b.average) ? 1 : ((b.average > a.average) ? -1 : 0)); // Sort by worst to last

				var targets = [scenarios[0].opponent, scenarios[1].opponent];

				teamPerformance = self.calculateAverageRosterPerformance(roster, targets);

				// Add the best bodyguard that isn't the currently selected Pokemon
				for(var i = 0; i < teamPerformance.length; i++){
					if(team.indexOf(teamPerformance[i].pokemon) == -1){
						team.push(teamPerformance[i].pokemon);
						break;
					}
				}

				// Finally, let's round them out with a Pokemon that does best against their collective counters
				teamPerformance = self.calculateAverageRosterPerformance(opponentRoster, team);
				targets = [teamPerformance[0].pokemon, teamPerformance[1].pokemon];

				teamPerformance = self.calculateAverageRosterPerformance(roster, targets);
				// Add the best bodyguard that isn't the currently selected Pokemon
				for(var i = 0; i < teamPerformance.length; i++){
					if(team.indexOf(teamPerformance[i].pokemon) == -1){
						team.push(teamPerformance[i].pokemon);
						break;
					}
				}

				break;

			// Choose two high performance Pokemon and lead with a bodyguard
			case "UNBALANCED":
				var teamPerformance = self.calculateAverageRosterPerformance(roster, opponentRoster);

				// Choose the best two average Pokemon
				team.push(teamPerformance[0].pokemon, teamPerformance[1].pokemon);

				// Finally, let's round lead with a Pokemon that does best against their collective counters
				teamPerformance = self.calculateAverageRosterPerformance(opponentRoster, team);
				targets = [teamPerformance[0].pokemon, teamPerformance[1].pokemon];

				teamPerformance = self.calculateAverageRosterPerformance(roster, targets);
				// Add the best bodyguard that isn't the currently selected Pokemon
				for(var i = 0; i < teamPerformance.length; i++){
					if(team.indexOf(teamPerformance[i].pokemon) == -1){
						team.splice(0, 0, teamPerformance[i].pokemon);
						break;
					}
				}

				break;

			// Use the same team as last time
			case "SAME_TEAM":
				var previousTeam = previousTeams[1];

				for(var i = 0; i < previousTeam.length; i++){
					team.push(previousTeam[i]);
				}
				break;

			// Use the same team as last time but with the previous lead's bodyguard as the lead
			case "SAME_TEAM_DIFFERENT_LEAD":
				var previousTeam = previousTeams[1];

				team.push(previousTeam[1]);
				previousTeam.splice(1,1);

				for(var i = 0; i < previousTeam.length; i++){
					team.push(previousTeam[i]);
				}
				break;

			// Choose a team that counters the opponent's previous lead
			case "COUNTER_LAST_LEAD":
				var opponentPreviousLead = previousTeams[0][0];

				var teamPerformance = self.calculateAverageRosterPerformance([opponentPreviousLead], roster);
				var scenarios = teamPerformance[0].scenarios;

				scenarios.sort((a,b) => (a.average > b.average) ? 1 : ((b.average > a.average) ? -1 : 0)); // Sort by worst to best

				// Lead with the best counter
				team.push(scenarios[0].opponent);

				// Next, let's give it a bodyguard
				var scenarios = self.runBulkScenarios("NO_BAIT", team[0], opponentRoster);
				scenarios.sort((a,b) => (a.average > b.average) ? 1 : ((b.average > a.average) ? -1 : 0)); // Sort by worst to last

				var targets = [scenarios[0].opponent, scenarios[1].opponent];

				teamPerformance = self.calculateAverageRosterPerformance(roster, targets);

				// Add the best bodyguard that isn't the currently selected Pokemon
				for(var i = 0; i < teamPerformance.length; i++){
					if(team.indexOf(teamPerformance[i].pokemon) == -1){
						team.push(teamPerformance[i].pokemon);
						break;
					}
				}

				// Finally, let's round them out with a Pokemon that does best against their collective counters
				teamPerformance = self.calculateAverageRosterPerformance(opponentRoster, team);
				targets = [teamPerformance[0].pokemon, teamPerformance[1].pokemon];

				teamPerformance = self.calculateAverageRosterPerformance(roster, targets);
				// Add the best bodyguard that isn't the currently selected Pokemon
				for(var i = 0; i < teamPerformance.length; i++){
					if(team.indexOf(teamPerformance[i].pokemon) == -1){
						team.push(teamPerformance[i].pokemon);
						break;
					}
				}

				break;
		}

		player.setTeam(team);
	}

	// Return an array of average performances of team A against team B

	this.calculateAverageRosterPerformance = function(teamA, teamB){
		var results = [];

		for(var i = 0; i < teamA.length; i++){
			var scenarios = self.runBulkScenarios("NO_BAIT", teamA[i], teamB);
			var average = 0;

			for(var n = 0; n < scenarios.length; n++){
				average += scenarios[n].average;
			}

			average /= scenarios.length;

			results.push({
				pokemon: teamA[i],
				scenarios: scenarios,
				average: average
			});
		}

		// Sort by average rating
		results.sort((a,b) => (a.average > b.average) ? -1 : ((b.average > a.average) ? 1 : 0));
		return results;
	}

	// Set the pool of available Pokemon from data

	this.setTeamPool = function(league, cup, data){
		teamPool[league+""+cup] = data;
		self.generateRoster(partySize, generateRosterCallback);
	}

	// Evaluate the current matchup and decide a high level strategy

	this.evaluateMatchup = function(turn, pokemon, opponent, opponentPlayer){
		// Preserve current HP, energy, and stat boosts
		pokemon.startHp = pokemon.hp;
		pokemon.startEnergy = pokemon.energy;
		pokemon.startStatBuffs = [pokemon.statBuffs[0], pokemon.statBuffs[1]];
		pokemon.startCooldown = pokemon.cooldown;
		pokemon.startingShields = pokemon.shields;
		pokemon.baitShields = true;
		pokemon.farmEnergy = false;

		opponent.startHp = opponent.hp;
		opponent.startEnergy = opponent.energy;
		opponent.startStatBuffs = [opponent.statBuffs[0], opponent.statBuffs[1]];
		opponent.startCooldown = opponent.cooldown;
		opponent.startingShields = opponent.shields;
		opponent.baitShields = true;
		opponent.farmEnergy = false;

		// Sim multiple scenarios to help determine strategy

		scenarios = {};

		scenarios.bothBait = self.runScenario("BOTH_BAIT", pokemon, opponent);
		scenarios.neitherBait = self.runScenario("NEITHER_BAIT", pokemon, opponent);
		scenarios.noBait = self.runScenario("NO_BAIT", pokemon, opponent);
		scenarios.farm = self.runScenario("FARM", pokemon, opponent);

		var overallRating = (scenarios.bothBait.average + scenarios.neitherBait.average + scenarios.noBait.average) / 3;

		console.log(pokemon.speciesId + " rating " + overallRating);

		var options = [];
		var totalSwitchWeight = 0;

		if((self.hasStrategy("SWITCH_BASIC"))&&(player.getSwitchTimer() == 0)&&(player.getRemainingPokemon() > 1)){
			var switchThreshold = 500;

			if((self.hasStrategy("PRESERVE_SWITCH_ADVANTAGE"))&&(opponentPlayer.getRemainingPokemon() > 1)){
				switchThreshold = 450;
			}

			var switchWeight = Math.floor(Math.max((switchThreshold - overallRating) / 10, 0));

			// Is the opponent switch locked and do I have a better Pokemon for it?
			if(opponentPlayer.getSwitchTimer() > 20){
				var team = player.getTeam();
				var remainingPokemon = [];

				for(var i = 0; i < team.length; i++){
					if((team[i].hp > 0)&&(team[i] != pokemon)){
						remainingPokemon.push(team[i]);
					}
				}

				console.log(remainingPokemon);

				console.log(pokemon.speciesId + " has a current rating of " + overallRating);

				for(var i = 0; i < remainingPokemon.length; i++){
					var scenario = self.runScenario("NO_BAIT", remainingPokemon[i], opponent);
					var rating = scenario.average;
					console.log(remainingPokemon[i].speciesId + " has an average of " + rating + " vs " + opponent.speciesId);
					if(rating >= overallRating){
						switchWeight += Math.round((rating-overallRating)/10);
					}
				}
			}

			// Don't switch Pokemon when HP is low
			if((self.hasStrategy("PRESERVE_SWITCH_ADVANTAGE"))&&(opponentPlayer.getSwitchTimer() - player.getSwitchTimer() < 30)&&(pokemon.hp / pokemon.stats.hp <= .25)&&(opponentPlayer.getRemainingPokemon() > 1)){
				switchWeight = 0;
			}
			options.push(new DecisionOption("SWITCH_BASIC", switchWeight));

			totalSwitchWeight += switchWeight;

			// See if it's feasible to build up energy before switching
			if(self.hasStrategy("SWITCH_FARM")){
				var dpt = (opponent.fastMove.damage / (opponent.fastMove.cooldown / 500));
				var percentPerTurn = (dpt / pokemon.stats.hp) * 100; // The opponent's fast attack will deal this % damage per turn
				var weightFactor =  Math.pow(Math.round(Math.max(3 - percentPerTurn, 0)), 2);

				// Switch immediately if previously failed to switch before a Charged Move
				if(previousStrategy == "SWITCH_FARM"){
					weightFactor = 0;
				}

				console.log("percent per turn " + percentPerTurn);
				if(percentPerTurn > 3){
					weightFactor = 0;
				}

				totalSwitchWeight += (switchWeight * weightFactor);
				options.push(new DecisionOption("SWITCH_FARM", switchWeight * weightFactor));

				console.log("Switch Farm: " + (switchWeight * weightFactor));
			}

			console.log("Switch: " + switchWeight);
		}

		// If there's a decent chance this Pokemon really shouldn't switch out, add other actions

		if(totalSwitchWeight < 10){
			options.push(new DecisionOption("DEFAULT", 2));

			console.log("Default: 2");

			if((self.hasStrategy("BAIT_SHIELDS"))&&(opponent.shields > 0)){
				var baitWeight = Math.max(Math.round( (scenarios.bothBait.average - scenarios.noBait.average) / 20), 1);

				// If this Pokemon's moves are very close in DPE, prefer the shorter energy move
				if((scenarios.bothBait.average >= 500)&&(pokemon.chargedMoves.length == 2)){
					if(Math.abs(pokemon.chargedMoves[0].dpe - pokemon.chargedMoves[1].dpe) <= .1){
						baitWeight += 5;
					}
				}

				// If behind on shields, bait more
				if(player.getShields() < opponentPlayer.getShields()){
					baitWeight += 2;
				}

				// If the Pokemon has very low health, don't bait
				if((pokemon.hp / pokemon.stats.hp < .25)&&(pokemon.energy < 70)){
					baitWeight = 0;
				}

				options.push(new DecisionOption("BAIT_SHIELDS", baitWeight));

				console.log("Bait: " + baitWeight);
			}

			if(self.hasStrategy("FARM_ENERGY")){
				var farmWeight = Math.round( (scenarios.farm.average - 600) / 20);

				// Let's farm if we'll win and the opponent is low on energy
				if((opponent.energy < 20)&&(scenarios.farm.average > 525)){
					farmWeight += 12;
				}

				// Don't farm against the last Pokemon
				if(opponentPlayer.getRemainingPokemon() < 2){
					farmWeight = 0;
				}

				// Let's make very certain to farm if that looks like a winning strategy
				if((self.hasStrategy("BAD_DECISION_PROTECTION"))&&(farmWeight >= 15)){
					farmWeight *= 5;
				}

				options.push(new DecisionOption("FARM", farmWeight));

				console.log("Farm: " + farmWeight);
			}
		}

		// Decide the AI's operating strategy
		var option = self.chooseOption(options);
		self.processStrategy(option.name);

		console.log(option.name);

		if(turn !== undefined){
			turnLastEvaluated = battle.getTurns();
		} else{
			turnLastEvaluated = 1;
		}
	}

	// Run a specific scenario

	this.runScenario = function(type, pokemon, opponent){
		var scenario = {
			opponent: opponent,
			name: type,
			matchups: [],
			average: 0,
			minShields: 3
		};

		// Preserve old Pokemon stats
		var startStats = [
			{
				shields: pokemon.startingShields,
				hp: pokemon.hp,
				energy: pokemon.energy,
				cooldown: pokemon.cooldown
			},
			{
				shields: opponent.startingShields,
				hp: opponent.hp,
				energy: opponent.energy,
				cooldown: opponent.cooldown
			}
		];

		switch(type){
			case "BOTH_BAIT":
				pokemon.baitShields = true;
				pokemon.farmEnergy = false;
				opponent.baitShields = true;
				opponent.farmEnergy = false;
				break;

			case "NEITHER_BAIT":
				pokemon.baitShields = false;
				pokemon.farmEnergy = false;
				opponent.baitShields = false;
				opponent.farmEnergy = false;
				break;

			case "NO_BAIT":
				pokemon.baitShields = false;
				pokemon.farmEnergy = false;
				opponent.baitShields = true;
				opponent.farmEnergy = false;
				break;

			case "FARM":
				pokemon.baitShields = true;
				pokemon.farmEnergy = true;
				opponent.baitShields = true;
				opponent.farmEnergy = false;
				break;
		}

		var b = new Battle();
		b.setNewPokemon(pokemon, 0, false);
		b.setNewPokemon(opponent, 1, false);

		for(var i = 0; i <= startStats[0].shields; i++){
			for(n = 0; n <= startStats[1].shields; n++){
				pokemon.startingShields = i;
				opponent.startingShields = n;
				b.simulate();

				var rating = b.getBattleRatings()[0];
				scenario.matchups.push(rating);
				scenario.average += rating;

				if((rating >= 500)&&(i < scenario.minShields)){
					scenario.minShields = i;
				}
			}
		}

		scenario.average /= scenario.matchups.length;

		pokemon.startingShields = startStats[0].shields;
		pokemon.startHp = startStats[0].hp;
		pokemon.startEnergy = startStats[0].energy;
		pokemon.startCooldown = startStats[0].cooldown;

		opponent.startingShields = startStats[1].shields;
		opponent.startHp = startStats[1].hp;
		opponent.startEnergy = startStats[1].energy;
		opponent.startCooldown = startStats[1].cooldown;

		pokemon.reset();
		opponent.reset();
		pokemon.index = 1;
		pokemon.farmEnergy = false;
		opponent.index = 0;
		opponent.farmEnergy = false;

		return scenario;
	}

	this.runBulkScenarios = function(type, pokemon, opponents){
		var scenarios = [];

		for(var i = 0; i < opponents.length; i++){
			var scenario = self.runScenario(type, pokemon, opponents[i]);
			scenarios.push(scenario);
		}

		return scenarios;
	}

	// Choose an option from an array
	this.chooseOption = function(options){
		var optionBucket = [];

		// Put all the options in bucket, multiple times for its weight value

		for(var i = 0; i < options.length; i++){
			for(var n = 0; n < options[i].weight; n++){
				optionBucket.push(options[i].name);
			}
		}

		// If all options have 0 weight, just toss the first option in there

		if(optionBucket.length == 0){
			optionBucket.push(options[0].name);
		}

		var index = Math.floor(Math.random() * optionBucket.length);
		var optionName = optionBucket[index];
		var option = options.filter(obj => {
			return obj.name === optionName
		})[0];

		return option;
	}

	// Change settings to accomodate a new strategy

	this.processStrategy = function(strategy){
		previousStrategy = currentStrategy;
		currentStrategy = strategy;

		var pokemon = battle.getPokemon()[player.getIndex()];

		switch(currentStrategy){
			case "SWITCH_FARM":
				pokemon.farmEnergy = true;
				break;

			case "FARM":
				pokemon.farmEnergy = true;
				break;

			case "DEFAULT":
				pokemon.baitShields = false;
				pokemon.farmEnergy = false;
				break;

			case "BAIT_SHIELDS":
				pokemon.baitShields = true;
				pokemon.farmEnergy = false;
				break;
		}
	}

	this.decideAction = function(turn, poke, opponent){
		var action = null;

		poke.setBattle(battle);
		poke.resetMoves();

		if((currentStrategy.indexOf("SWITCH") > -1) && (player.getSwitchTimer() == 0)){
			var performSwitch = false;

			if((currentStrategy == "SWITCH_BASIC") && (turn - turnLastEvaluated >= props.reactionTime)){
				performSwitch = true;
			}

			if(currentStrategy == "SWITCH_FARM"){
				// Check to see if the opposing Pokemon is close to a damaging Charged Move
				var potentialDamage = self.calculatePotentialDamage(opponent, poke, opponent.energy);

				// How much potential damage will they have after one more Fast Move?

				var extraFastMoves = Math.floor((poke.fastMove.cooldown - opponent.cooldown) / (opponent.fastMove.cooldown));

				if(poke.fastMove.cooldown != opponent.fastMove.cooldown){
					extraFastMoves = Math.floor((poke.fastMove.cooldown) / (opponent.fastMove.cooldown));
				}

				var futureEnergy = opponent.energy + (extraFastMoves * opponent.fastMove.energyGain);
				var futureDamage = self.calculatePotentialDamage(opponent, poke, futureEnergy);

				if((futureDamage >= poke.hp)||(futureDamage >= poke.stats.hp * .15)){
					performSwitch = true;
				}

			}

			if(performSwitch){
				// Determine a Pokemon to switch to
				var switchChoice = self.decideSwitch();
				action = new TimelineAction("switch", player.getIndex(), turn, switchChoice, {priority: poke.priority});
			}
		}

		poke.resetMoves(true);

		if(! action){
			action = battle.decideAction(poke, opponent);
		}

		return action;
	}

	// Return the index of a Pokemon to switch to

	this.decideSwitch = function(){
		var switchOptions = [];
		var team = player.getTeam();
		var poke = battle.getPokemon()[player.getIndex()];
		var opponent = battle.getOpponent(player.getIndex());
		var opponentPlayer = battle.getPlayers()[opponent.index];

		for(var i = 0; i < team.length; i++){
			var pokemon = team[i];

			if((pokemon.hp > 0)&&(pokemon != poke)){
				var scenario = self.runScenario("NO_BAIT", pokemon, opponent);
				var weight = 1;

				// Dramatically scale weight based on winning or losing
				if(scenario.average < 500){
					weight = Math.max(Math.round(Math.pow(scenario.average / 100, 4) / 20), 1);
				} else{
					// If the opponent is switch locked, favor the hard counter
					if(opponentPlayer.getSwitchTimer() < 10){
						weight = Math.round((scenario.average-250) / 2);
					} else{
						weight = Math.round(Math.pow((scenario.average-250) / 100, 4));
					}

				}

				switchOptions.push(new DecisionOption(i, weight));


				console.log(pokemon.speciesId + " " + scenario.average + " " + weight);
			}
		}

		var switchChoice = self.chooseOption(switchOptions);
		return switchChoice.name;
	}

	// Decide whether or not to shield a Charged Attack

	this.decideShield = function(attacker, defender, m){
		// First, how hot are we looking in this current matchup?
		var currentScenario = self.runScenario("NO_BAIT", defender, attacker);
		var currentRating = currentScenario.average;
		var currentHp = defender.hp;
		var estimatedEnergy = attacker.energy + (Math.floor(Math.random() * (props.energyGuessRange * 2)) - props.energyGuessRange);
		var potentialDamage = 0;
		var potentialHp = defender.hp - potentialDamage;

		// Which move do we think the attacker is using?
		var moves = [];
		var minimumEnergy = 100;

		// Don't allow the AI to guess less energy than the opponent's fastest move
		for(var i = 0; i < attacker.chargedMoves.length; i++){
			if(minimumEnergy > attacker.chargedMoves[i].energy){
				minimumEnergy = attacker.chargedMoves[i].energy;
			}
		}

		if(estimatedEnergy < minimumEnergy){
			estimatedEnergy = minimumEnergy; // Want to make sure at least one valid move can be guessed
		}

		for(var i = 0; i < attacker.chargedMoves.length; i++){
			if(estimatedEnergy >= attacker.chargedMoves[i].energy){
				attacker.chargedMoves.damage = battle.calculateDamage(attacker, defender, attacker.chargedMoves[i], true);
				moves.push(attacker.chargedMoves[i]);
			}
		}

		// Sort moves by damage

		moves.sort((a,b) => (a.damage > b.damage) ? -1 : ((b.damage > a.damage) ? 1 : 0));

		var moveGuessOptions = [];

		for(var i = 0; i < moves.length; i++){
			var moveWeight = 1;

			// Is the opponent low on HP? Probably the higher damage move
			if((i == 0)&&(attacker.hp / attacker.stats.hp <= .25)){
				moveWeight += 8;

				if(moves[i].name == "Acid Spray"){
					moveWeight += 12;
				}
			}

			// Am I the last Pokemon and will this move faint me? Better protect myself
			if((player.getRemainingPokemon() == 1)&&(moves[i].damage >= defender.hp)){
				moveWeight += 4;
			}

			// Is this move lower damage and higher energy? Definitely the other one, then
			if((i == 1)&&(moves[i].damage < moves[0].damage)&&(moves[i].energy >= moves[0].energy)&&(moves[i].name != "Acid Spray")){
				moveGuessOptions[0].weight += 20;
			}
			moveGuessOptions.push(new DecisionOption(i, moveWeight));
		}

		var move = moves[self.chooseOption(moveGuessOptions).name]; // The guessed move of the attacker

		console.log("Predicting " + move.name);

		// Great! We've guessed the move, now let's analyze if we should shield like a player would
		var yesWeight = 1;
		var noWeight = 1;

		// Will this attack hurt?
		var damageWeight = Math.min(Math.round((move.damage / Math.max(defender.hp, defender.hp / 2)) * 10), 10);
		var moveDamage = move.damage;
		var fastMoveDamage = attacker.fastMove.damage;

		if(damageWeight > 4){
			yesWeight += ((damageWeight - 4) * 2);
		} else{
			noWeight += 6 - damageWeight;
		}

		// Is this move going to knock me out?
		if(moveDamage + (fastMoveDamage * 2) >= defender.hp){
			// How good of a matchup is this for us?
			if(currentRating > 500){
				yesWeight += Math.round((currentRating - 500) / 10)
			} else if(player.getRemainingPokemon() > 1){
				noWeight += Math.round((500 - currentRating) / 10)
			}
		} else if(self.hasStrategy("ADVANCED_SHIELDING")){
			// Save shields until they're needed
			noWeight += 4;
		}

		// Monkey see, monkey do
		if((attacker.battleStats.shieldsUsed > 0)&&(damageWeight > 2)&&(! self.hasStrategy("ADVANCED_SHIELDING"))){
			yesWeight += 2;
		}

		// Is this Pokemon close to a move that will faint or seriously injure the attacker?
		for(var i = 0; i < defender.chargedMoves.length; i++){
			var move = defender.chargedMoves[i];
			var turnsAway = Math.ceil( (move.energy - defender.energy) / defender.fastMove.energyGain ) * defender.fastMove.cooldown;

			if( ((moveDamage >= attacker.hp)||((moveDamage >= defender.stats.hp * .75)))&&(turnsAway <= 2)){
				if(! self.hasStrategy("ADVANCED_SHIELDING")){
					yesWeight += 2;
				} else{
					// Let's also check that this move will faint or deal a lot of damage
					if(moveDamage + (fastMoveDamage * 2) >= defender.hp){
						yesWeight += 2;
					} else{
						noWeight += 2;
					}
				}
			}
		}

		// Does my current Pokemon have a better matchup against the attacker than my remaining Pokemon?
		if((self.hasStrategy("ADVANCED_SHIELDING"))&&(player.getRemainingPokemon() > 1)){
			var team = player.getTeam();
			var remainingPokemon = [];

			for(var i = 0; i < team.length; i++){
				if((team[i].hp > 0)&&(team[i] != defender)){
					remainingPokemon.push(team[i]);
				}
			}

			var betterMatchupExists = false;

			console.log("Current rating " + currentRating);

			for(var i = 0; i < remainingPokemon.length; i++){
				var scenario = self.runScenario("NO_BAIT", remainingPokemon[i], attacker);

				console.log(remainingPokemon[i].speciesId + " rating " + scenario.average);

				if(scenario.average >= currentRating){
					betterMatchupExists = true;
				}
			}

			if(! betterMatchupExists){
				console.log("No better matchup exists");
			}

			if((! betterMatchupExists)&&(currentRating >= 500)&&((damageWeight > 3)||(moveDamage + (fastMoveDamage * 2) >= defender.hp))){
				yesWeight += 20;
				noWeight = Math.round(noWeight / 2);
			}
		}

		// How many Pokemon do I have left compared to shields?
		if((currentRating >= 500)||(player.getRemainingPokemon() == 1)){
			yesWeight += (3 - player.getRemainingPokemon()) * (damageWeight-1) * 2;
		}

		// If one of these options is significantly more weighted than the other, make it the only option
		if(self.hasStrategy("BAD_DECISION_PROTECTION")){
			if(yesWeight / noWeight >= 4){
				noWeight = 0;
			} else if (noWeight / yesWeight >= 4){
				yesWeight = 0;
			}
		}

		var options = [];
		options.push(new DecisionOption(true, yesWeight));
		options.push(new DecisionOption(false, noWeight));

		console.log("Yes: " + yesWeight);
		console.log("No: " + noWeight);

		var decision = self.chooseOption(options).name;

		return decision;
	}

	// Given a pokemon and its stored energy, how much potential damage can it deal?

	this.calculatePotentialDamage = function(attacker, defender, energy, stack){
		stack = typeof stack !== 'undefined' ? stack : true;

		var totalDamage = [];

		for(var i = 0; i < attacker.chargedMoves.length; i++){
			var countMultiplier = Math.floor(energy / attacker.chargedMoves[i].energy);
			if(! stack){
				countMultiplier = 0;
				if(attacker.chargedMoves[i].energy <= energy){
					countMultiplier = 1;
				}
			}

			var damage = countMultiplier * battle.calculateDamage(attacker, defender, attacker.chargedMoves[i], true);
			totalDamage.push(damage);
		}

		if(totalDamage.length == 0){
			return 0;
		} else{
			return Math.max.apply(Math, totalDamage);
		}
	}

	// Return whether not this AI can run the provided strategy
	this.hasStrategy = function(strategy){
		return (props.strategies.indexOf(strategy) > -1);
	}

	// Return the AI's difficulty level

	this.getLevel = function(){
		return level;
	}

	// Return the name of the difficulty level
	this.difficultyToString = function(){
		var name = "AI";

		switch(level){
			case 0:
				name = "Novice";
				break;

			case 1:
				name = "Rival";
				break;

			case 2:
				name = "Elite";
				break;

			case 3:
				name = "Champion";
				break;
		}

		return name;
	}

}
